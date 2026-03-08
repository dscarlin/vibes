#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  collections::HashMap,
  fs,
  io::{Read, Seek, SeekFrom, Write},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::{Mutex, OnceLock}
};

use dirs_next::home_dir;
use flate2::read::GzDecoder;
use get_if_addrs::{get_if_addrs, IfAddr};
use reqwest::blocking::Client;
use serde::Serialize;
use std::net::{Ipv4Addr, TcpStream, ToSocketAddrs};
use std::time::Duration;
use tar::Archive;

#[derive(Serialize)]
struct RepoMeta {
  project_id: String,
  project_name: Option<String>,
  repo_root: String,
  downloaded_at: String
}

#[derive(Serialize)]
struct AndroidSetupStatus {
  studio_installed: bool,
  sdk_root: Option<String>,
  sdkmanager: bool,
  avdmanager: bool,
  emulator: bool,
  adb: bool,
  adb_in_path: bool,
  emulator_in_path: bool,
  java_home: Option<String>,
  java_ok: bool,
  devices: Vec<String>,
  avds: Vec<String>,
  arch: String
}

#[derive(Serialize)]
struct IosSetupStatus {
  supported: bool,
  xcode_installed: bool,
  xcode_license: bool,
  simulators: Vec<String>
}

#[derive(Serialize)]
struct MobileRunStatus {
  booted: bool,
  devices: Vec<String>
}

fn run_shell(command: &str, cwd: &Path, env: Option<&HashMap<String, String>>) -> Result<String, String> {
  let mut cmd = Command::new("sh");
  cmd.arg("-lc").arg(command).current_dir(cwd);
  if let Some(envs) = env {
    cmd.envs(envs);
  }
  let output = cmd.output().map_err(|err| err.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  Ok(format!("{}{}", stdout, stderr))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  if url.trim().is_empty() {
    return Err("URL required".to_string());
  }
  if cfg!(target_os = "macos") {
    Command::new("open")
      .arg(&url)
      .spawn()
      .map_err(|err| err.to_string())?;
    return Ok(());
  }
  if cfg!(target_os = "windows") {
    Command::new("cmd")
      .args(["/C", "start", "", &url])
      .spawn()
      .map_err(|err| err.to_string())?;
    return Ok(());
  }
  Command::new("xdg-open")
    .arg(&url)
    .spawn()
    .map_err(|err| err.to_string())?;
  Ok(())
}

fn process_registry() -> &'static Mutex<HashMap<String, u32>> {
  static REGISTRY: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
  REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_long_running(command: &str) -> bool {
  let cmd = command.to_lowercase();
  cmd.contains("npm run dev")
    || cmd.contains("npm start")
    || cmd.contains("expo start")
    || cmd.contains("expo run:ios")
    || cmd.contains("expo run:android")
    || cmd.contains("server/src/index.js")
    || cmd.contains("npm --prefix server")
}

fn spawn_long_running(
  command: &str,
  cwd: &Path,
  kill_existing: bool,
  env: Option<&HashMap<String, String>>
) -> Result<String, String> {
  let key = format!("{}::{}", cwd.to_string_lossy(), command);
  if kill_existing {
    if let Ok(mut registry) = process_registry().lock() {
      if let Some(pid) = registry.remove(&key) {
        let _ = Command::new("sh")
          .arg("-lc")
          .arg(format!("kill {} 2>/dev/null || true", pid))
          .spawn();
      }
    }
  }

  let logs_dir = default_projects_dir().join(".logs");
  fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;
  let filename = format!("local-run-{}.log", chrono::Utc::now().timestamp());
  let log_path = logs_dir.join(filename);
  let log_file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|err| err.to_string())?;
  let log_file_err = log_file.try_clone().map_err(|err| err.to_string())?;

  let mut cmd = Command::new("sh");
  cmd
    .arg("-lc")
    .arg(command)
    .current_dir(cwd)
    .stdout(Stdio::from(log_file))
    .stderr(Stdio::from(log_file_err));
  if let Some(envs) = env {
    cmd.envs(envs);
  }
  cmd
    .spawn()
    .map_err(|err| err.to_string())
    .map(|child| {
      if let Ok(mut registry) = process_registry().lock() {
        registry.insert(key, child.id());
      }
    })?;

  Ok(format!(
    "Started in background. Logs: {}\n",
    log_path.to_string_lossy()
  ))
}

#[tauri::command]
fn stop_local_runs() -> Result<String, String> {
  let mut stopped = 0;
  if let Ok(mut registry) = process_registry().lock() {
    for (_key, pid) in registry.drain() {
      let _ = Command::new("sh")
        .arg("-lc")
        .arg(format!("kill {} 2>/dev/null || true", pid))
        .spawn();
      stopped += 1;
    }
  }
  if stopped == 0 {
    return Ok("No running processes.".to_string());
  }
  Ok(format!("Stopped {} process(es).", stopped))
}

fn ensure_node_modules(dir: &Path) -> Result<String, String> {
  let node_modules = dir.join("node_modules");
  let package_json = dir.join("package.json");
  let package_lock = dir.join("package-lock.json");
  let mut should_install = !node_modules.exists();

  if !should_install {
    let node_meta = fs::metadata(&node_modules).ok();
    let pkg_meta = fs::metadata(&package_json).ok();
    let lock_meta = fs::metadata(&package_lock).ok();
    if let (Some(node_meta), Some(pkg_meta)) = (node_meta.as_ref(), pkg_meta.as_ref()) {
      if let (Ok(node_time), Ok(pkg_time)) = (node_meta.modified(), pkg_meta.modified()) {
        if pkg_time > node_time {
          should_install = true;
        }
      }
    }
    if let (Some(node_meta), Some(lock_meta)) = (node_meta.as_ref(), lock_meta.as_ref()) {
      if let (Ok(node_time), Ok(lock_time)) = (node_meta.modified(), lock_meta.modified()) {
        if lock_time > node_time {
          should_install = true;
        }
      }
    }
  }

  if should_install {
    return run_shell("npm install", dir, None);
  }
  Ok(String::new())
}

fn resolve_npm_command(command: &str, cwd: &Path) -> String {
  let trimmed = command.trim();
  let is_plain_dev = trimmed == "npm run dev" || trimmed.starts_with("npm run dev ");
  if !is_plain_dev {
    return command.to_string();
  }
  let pkg_path = cwd.join("package.json");
  let raw = match fs::read_to_string(pkg_path) {
    Ok(raw) => raw,
    Err(_) => return command.to_string()
  };
  let value: serde_json::Value = match serde_json::from_str(&raw) {
    Ok(value) => value,
    Err(_) => return command.to_string()
  };
  let scripts = match value.get("scripts").and_then(|v| v.as_object()) {
    Some(scripts) => scripts,
    None => return command.to_string()
  };
  let has_dev = scripts.get("dev").is_some();
  let has_start = scripts.get("start").is_some();
  if !has_dev && has_start {
    return command.replace("npm run dev", "npm start");
  }
  command.to_string()
}

#[tauri::command]
fn run_local_command(
  command: String,
  cwd: Option<String>,
  kill_existing: Option<bool>,
  env: Option<HashMap<String, String>>
) -> Result<String, String> {
  let cwd_path = cwd
    .filter(|dir| !dir.trim().is_empty())
    .map(PathBuf::from);
  let resolved = cwd_path.map(|dir| detect_repo_root(&dir));
  let cwd_dir = pick_command_cwd(&command, resolved);

  if let Some(dir) = cwd_dir {
    let mut envs = env.unwrap_or_default();
    let mut output = String::new();
    let command_lower = command.to_lowercase();
    ensure_local_cors_env(&mut envs, &command_lower, &dir);
    if command_lower.contains("expo") {
      output.push_str(&ensure_node_modules(&dir)?);
    }
    let is_expo_run = command_lower.contains("expo run:ios") || command_lower.contains("expo run:android");
    if command_lower.contains("expo run:ios") || command_lower.contains("pod install") {
      envs.entry("LANG".to_string()).or_insert_with(|| "en_US.UTF-8".to_string());
      envs.entry("LC_ALL".to_string()).or_insert_with(|| "en_US.UTF-8".to_string());
    }
    if command_lower.contains("expo run:android") {
      ensure_java_env(&mut envs);
      if let Some(sdk_root) = ensure_android_env(&mut envs) {
        let _ = ensure_android_local_properties(&dir, &sdk_root);
      }
    }
    if is_expo_run {
      let _ = run_shell("lsof -ti:8081 | xargs kill -9 2>/dev/null || true", &dir, Some(&envs));
    }
    let mut run_command = resolve_npm_command(&command, &dir);
    if is_expo_run {
      run_command = format!(
        "EXPO_DEV_SERVER_HOST=127.0.0.1 REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 {}",
        run_command
      );
    }
    if is_long_running(&run_command) || is_expo_run {
      let should_kill = kill_existing.unwrap_or(false);
      output.push_str(&spawn_long_running(&run_command, &dir, should_kill, Some(&envs))?);
    } else {
      output.push_str(&run_shell(&run_command, &dir, Some(&envs))?);
    }
    return Ok(output);
  }

  let output = Command::new("sh")
    .arg("-lc")
    .arg(&command)
    .output()
    .map_err(|err| err.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  Ok(format!("{}{}", stdout, stderr))
}

#[tauri::command]
fn write_mobile_env(api_url: String, cwd: Option<String>) -> Result<String, String> {
  let cwd_path = cwd
    .filter(|dir| !dir.trim().is_empty())
    .map(PathBuf::from)
    .map(|dir| detect_repo_root(&dir))
    .ok_or_else(|| "Missing project path".to_string())?;
  let mobile_dir = cwd_path.join("mobile");
  if !mobile_dir.exists() {
    return Err("mobile directory not found".to_string());
  }
  let env_path = mobile_dir.join(".env");
  let mut lines = vec![];
  if let Ok(raw) = fs::read_to_string(&env_path) {
    lines = raw.lines().map(|line| line.to_string()).collect();
  }
  let mut updated = false;
  for line in lines.iter_mut() {
    if line.trim_start().starts_with("EXPO_PUBLIC_API_URL=") {
      *line = format!("EXPO_PUBLIC_API_URL={}", api_url);
      updated = true;
      break;
    }
  }
  if !updated {
    lines.push(format!("EXPO_PUBLIC_API_URL={}", api_url));
  }
  let out = if lines.is_empty() {
    format!("EXPO_PUBLIC_API_URL={}\n", api_url)
  } else {
    format!("{}\n", lines.join("\n"))
  };
  fs::write(&env_path, out).map_err(|err| err.to_string())?;
  let _ = ensure_android_cleartext(&mobile_dir, &api_url);
  Ok(format!(
    "Updated mobile/.env with EXPO_PUBLIC_API_URL={}\n",
    api_url
  ))
}

#[tauri::command]
fn android_setup_status() -> AndroidSetupStatus {
  let sdk_root = android_sdk_root();
  let sdkmanager = sdk_root.as_ref().and_then(|root| resolve_sdkmanager(root));
  let avdmanager = sdk_root.as_ref().and_then(|root| resolve_avdmanager(root));
  let emulator = sdk_root.as_ref().and_then(|root| resolve_emulator(root));
  let adb = sdk_root.as_ref().and_then(|root| resolve_adb(root));
  let devices = adb
    .as_ref()
    .map(|path| list_android_devices(path))
    .unwrap_or_default();
  let java_home = resolve_java_home().map(|p| p.to_string_lossy().to_string());
  let java_ok = java_home.as_ref().map(|home| PathBuf::from(home).join("bin/java").exists()).unwrap_or(false)
    || command_in_path("java");
  AndroidSetupStatus {
    studio_installed: android_studio_installed(),
    sdk_root: sdk_root.as_ref().map(|p| p.to_string_lossy().to_string()),
    sdkmanager: sdkmanager.is_some(),
    avdmanager: avdmanager.is_some(),
    emulator: emulator.is_some(),
    adb: adb.is_some(),
    adb_in_path: command_in_path("adb"),
    emulator_in_path: command_in_path("emulator"),
    java_home,
    java_ok,
    devices,
    avds: list_avds(),
    arch: std::env::consts::ARCH.to_string()
  }
}

#[tauri::command]
fn android_setup_apply() -> Result<String, String> {
  let sdk_root = android_sdk_root().ok_or_else(|| {
    "Android SDK not found. Install Android Studio and open SDK Manager to install the SDK.".to_string()
  })?;
  let sdkmanager = resolve_sdkmanager(&sdk_root).ok_or_else(|| {
    "sdkmanager not found. In Android Studio, install Android SDK Command-line Tools.".to_string()
  })?;
  let avdmanager = resolve_avdmanager(&sdk_root).ok_or_else(|| {
    "avdmanager not found. In Android Studio, install Android SDK Command-line Tools.".to_string()
  })?;
  let arch = std::env::consts::ARCH;
  let abi = if arch == "aarch64" || arch == "arm64" { "arm64-v8a" } else { "x86_64" };
  let image = format!("system-images;android-34;google_apis;{}", abi);
  let sdk_root_str = sdk_root.to_string_lossy().to_string();
  let mut envs = HashMap::new();
  envs.insert("ANDROID_SDK_ROOT".to_string(), sdk_root_str.clone());
  envs.insert("ANDROID_HOME".to_string(), sdk_root_str.clone());

  let mut output = String::new();
  let install_cmd = format!(
    "\"{}\" --sdk_root=\"{}\" \"platform-tools\" \"platforms;android-34\" \"build-tools;34.0.0\" \"emulator\" \"{}\"",
    sdkmanager.to_string_lossy(),
    sdk_root_str,
    image
  );
  output.push_str(&run_shell(&install_cmd, Path::new("."), Some(&envs))?);

  let license_cmd = format!(
    "yes | \"{}\" --sdk_root=\"{}\" --licenses",
    sdkmanager.to_string_lossy(),
    sdk_root_str
  );
  output.push_str(&run_shell(&license_cmd, Path::new("."), Some(&envs))?);

  if list_avds().is_empty() {
    let create_cmd = format!(
      "printf 'no\\n' | \"{}\" create avd -n Vibes_API_34 -k \"{}\" --device \"pixel_7\"",
      avdmanager.to_string_lossy(),
      image
    );
    output.push_str(&run_shell(&create_cmd, Path::new("."), Some(&envs))?);
  }

  Ok(output)
}

#[tauri::command]
fn android_launch_emulator() -> Result<String, String> {
  let sdk_root = android_sdk_root().ok_or_else(|| {
    "Android SDK not found. Install Android Studio and open SDK Manager to install the SDK.".to_string()
  })?;
  let emulator = resolve_emulator(&sdk_root).ok_or_else(|| {
    "Android emulator not found. Install the Android Emulator in SDK Manager.".to_string()
  })?;
  let adb = resolve_adb(&sdk_root).ok_or_else(|| {
    "adb not found. Install Android SDK Platform-Tools in SDK Manager.".to_string()
  })?;
  let avds = list_avds();
  let avd = choose_best_avd(&avds).ok_or_else(|| {
    "No Android emulators found. Create one in Android Studio (Device Manager).".to_string()
  })?;
  let sdk_root_str = sdk_root.to_string_lossy().to_string();
  let mut envs = HashMap::new();
  envs.insert("ANDROID_SDK_ROOT".to_string(), sdk_root_str.clone());
  envs.insert("ANDROID_HOME".to_string(), sdk_root_str.clone());

  let _ = Command::new(adb).arg("start-server").envs(&envs).output();

  let logs_dir = default_projects_dir().join(".logs");
  fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;
  let filename = format!("android-emulator-{}.log", chrono::Utc::now().timestamp());
  let log_path = logs_dir.join(filename);
  let log_file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|err| err.to_string())?;
  let log_file_err = log_file.try_clone().map_err(|err| err.to_string())?;

  Command::new(emulator)
    .arg("-avd")
    .arg(avd)
    .arg("-no-snapshot-load")
    .arg("-gpu")
    .arg("auto")
    .envs(&envs)
    .stdout(Stdio::from(log_file))
    .stderr(Stdio::from(log_file_err))
    .spawn()
    .map_err(|err| err.to_string())?;

  let abi = avd_abi(avd).unwrap_or_else(|| "unknown".to_string());
  Ok(format!(
    "Launching emulator: {} (abi: {}). Logs: {}\n",
    avd,
    abi,
    log_path.to_string_lossy()
  ))
}

#[tauri::command]
fn android_setup_add_path() -> Result<String, String> {
  let sdk_root = android_sdk_root().ok_or_else(|| {
    "Android SDK not found. Install Android Studio and open SDK Manager to install the SDK.".to_string()
  })?;
  let java_home = resolve_java_home();
  let home = home_dir().ok_or_else(|| "Home directory not found.".to_string())?;
  let shell = std::env::var("SHELL").unwrap_or_default();
  let filename = if shell.contains("zsh") {
    ".zshrc"
  } else if shell.contains("bash") {
    ".bashrc"
  } else {
    ".profile"
  };
  let path = home.join(filename);
  let java_block = java_home
    .as_ref()
    .map(|home| format!("export JAVA_HOME=\"{}\"\n", home.to_string_lossy()))
    .unwrap_or_default();
  let block = format!(
    "\n# Vibes Android SDK\nexport ANDROID_SDK_ROOT=\"{}\"\nexport ANDROID_HOME=\"{}\"\n{}export PATH=\"$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH\"\n",
    sdk_root.to_string_lossy(),
    sdk_root.to_string_lossy(),
    java_block
  );
  if let Ok(existing) = fs::read_to_string(&path) {
    if existing.contains("Vibes Android SDK") || existing.contains("ANDROID_SDK_ROOT") {
      return Ok(format!("PATH already configured in {}", path.to_string_lossy()));
    }
    let mut next = existing;
    if !next.ends_with('\n') {
      next.push('\n');
    }
    next.push_str(&block);
    fs::write(&path, next).map_err(|err| err.to_string())?;
  } else {
    fs::write(&path, block).map_err(|err| err.to_string())?;
  }
  Ok(format!(
    "Added Android SDK to PATH in {}. Restart your terminal to use adb/emulator.",
    path.to_string_lossy()
  ))
}

#[tauri::command]
fn ios_setup_status() -> IosSetupStatus {
  if !cfg!(target_os = "macos") {
    return IosSetupStatus {
      supported: false,
      xcode_installed: false,
      xcode_license: false,
      simulators: vec![]
    };
  }
  let xcode_installed = xcode_app_installed();
  let xcode_license = xcodebuild_version_ok();
  let simulators = if xcode_installed && xcode_license {
    list_ios_simulators()
  } else {
    vec![]
  };
  IosSetupStatus {
    supported: true,
    xcode_installed,
    xcode_license,
    simulators
  }
}

#[tauri::command]
fn ios_runtime_status() -> MobileRunStatus {
  if !cfg!(target_os = "macos") {
    return MobileRunStatus { booted: false, devices: vec![] };
  }
  let devices = list_ios_booted_devices();
  MobileRunStatus {
    booted: !devices.is_empty(),
    devices
  }
}

#[tauri::command]
fn android_runtime_status() -> MobileRunStatus {
  let devices = resolve_adb_any()
    .as_ref()
    .map(|path| list_android_devices(path))
    .unwrap_or_default();
  MobileRunStatus {
    booted: !devices.is_empty(),
    devices
  }
}

#[tauri::command]
fn read_log_tail(path: String, max_bytes: Option<u64>) -> Result<String, String> {
  let max_bytes = max_bytes.unwrap_or(12000);
  let mut file = fs::File::open(&path).map_err(|err| err.to_string())?;
  let len = file.metadata().map_err(|err| err.to_string())?.len();
  let start = if len > max_bytes { len - max_bytes } else { 0 };
  file.seek(SeekFrom::Start(start)).map_err(|err| err.to_string())?;
  let mut buf = Vec::new();
  file.read_to_end(&mut buf).map_err(|err| err.to_string())?;
  Ok(String::from_utf8_lossy(&buf).to_string())
}

#[tauri::command]
fn is_port_open(host: String, port: u16, timeout_ms: Option<u64>) -> bool {
  let addr = format!("{}:{}", host, port);
  let timeout = Duration::from_millis(timeout_ms.unwrap_or(400));
  let mut addrs = match addr.to_socket_addrs() {
    Ok(addrs) => addrs,
    Err(_) => return false
  };
  if let Some(sock) = addrs.next() {
    return TcpStream::connect_timeout(&sock, timeout).is_ok();
  }
  false
}

fn default_projects_dir() -> PathBuf {
  if let Ok(dir) = std::env::var("VIBES_PROJECTS_DIR") {
    if !dir.trim().is_empty() {
      return PathBuf::from(dir);
    }
  }
  home_dir()
    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    .join("VibesProjects")
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
  let octets = ip.octets();
  match octets {
    [10, _, _, _] => true,
    [192, 168, _, _] => true,
    [172, b, _, _] if (16..=31).contains(&b) => true,
    _ => false
  }
}

#[tauri::command]
fn get_local_lan_ip() -> Option<String> {
  let mut fallback: Option<String> = None;
  let ifaces = get_if_addrs().ok()?;
  for iface in ifaces {
    if iface.is_loopback() {
      continue;
    }
    if let IfAddr::V4(v4) = iface.addr {
      let ip = v4.ip;
      if is_private_ipv4(ip) {
        return Some(ip.to_string());
      }
      if fallback.is_none() {
        fallback = Some(ip.to_string());
      }
    }
  }
  fallback
}

fn normalize_url(url: &str) -> String {
  url.trim_end_matches('/').to_string()
}

fn android_studio_installed() -> bool {
  if let Ok(path) = std::env::var("ANDROID_STUDIO_HOME") {
    if !path.trim().is_empty() && PathBuf::from(path).exists() {
      return true;
    }
  }
  if cfg!(target_os = "macos") {
    return PathBuf::from("/Applications/Android Studio.app").exists()
      || home_dir().map(|d| d.join("Applications/Android Studio.app").exists()).unwrap_or(false);
  }
  if cfg!(target_os = "windows") {
    if let Ok(program_files) = std::env::var("ProgramFiles") {
      let studio = PathBuf::from(program_files).join("Android/Android Studio/bin/studio64.exe");
      if studio.exists() {
        return true;
      }
    }
    if let Ok(program_files) = std::env::var("ProgramFiles(x86)") {
      let studio = PathBuf::from(program_files).join("Android/Android Studio/bin/studio64.exe");
      if studio.exists() {
        return true;
      }
    }
  }
  if cfg!(target_os = "linux") {
    return PathBuf::from("/opt/android-studio/bin/studio.sh").exists()
      || PathBuf::from("/usr/local/android-studio/bin/studio.sh").exists();
  }
  false
}

fn open_android_studio_app() -> Result<(), String> {
  if cfg!(target_os = "macos") {
    Command::new("open")
      .arg("-a")
      .arg("Android Studio")
      .spawn()
      .map_err(|err| err.to_string())?;
    return Ok(());
  }
  if cfg!(target_os = "windows") {
    if let Ok(program_files) = std::env::var("PROGRAMFILES") {
      let studio = PathBuf::from(program_files).join("Android/Android Studio/bin/studio64.exe");
      if studio.exists() {
        Command::new(studio).spawn().map_err(|err| err.to_string())?;
        return Ok(());
      }
    }
    if let Ok(program_files) = std::env::var("PROGRAMFILES(X86)") {
      let studio = PathBuf::from(program_files).join("Android/Android Studio/bin/studio64.exe");
      if studio.exists() {
        Command::new(studio).spawn().map_err(|err| err.to_string())?;
        return Ok(());
      }
    }
    return Err("Android Studio not found".to_string());
  }
  Command::new("sh")
    .arg("-lc")
    .arg("command -v studio >/dev/null 2>&1 && studio >/dev/null 2>&1 &")
    .spawn()
    .map_err(|err| err.to_string())?;
  Ok(())
}

#[tauri::command]
fn open_android_studio() -> Result<(), String> {
  open_android_studio_app()
}

fn android_sdk_root() -> Option<PathBuf> {
  if let Ok(root) = std::env::var("ANDROID_SDK_ROOT") {
    if !root.trim().is_empty() {
      let path = PathBuf::from(root);
      if path.exists() {
        return Some(path);
      }
    }
  }
  if let Ok(root) = std::env::var("ANDROID_HOME") {
    if !root.trim().is_empty() {
      let path = PathBuf::from(root);
      if path.exists() {
        return Some(path);
      }
    }
  }
  if cfg!(target_os = "macos") {
    if let Some(home) = home_dir() {
      let path = home.join("Library/Android/sdk");
      if path.exists() {
        return Some(path);
      }
    }
  }
  if cfg!(target_os = "linux") {
    if let Some(home) = home_dir() {
      let path = home.join("Android/Sdk");
      if path.exists() {
        return Some(path);
      }
    }
  }
  if cfg!(target_os = "windows") {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
      let path = PathBuf::from(local).join("Android/Sdk");
      if path.exists() {
        return Some(path);
      }
    }
  }
  None
}

fn resolve_sdkmanager(sdk_root: &Path) -> Option<PathBuf> {
  let candidates = [
    sdk_root.join("cmdline-tools/latest/bin/sdkmanager"),
    sdk_root.join("cmdline-tools/bin/sdkmanager"),
    sdk_root.join("cmdline-tools/tools/bin/sdkmanager"),
    sdk_root.join("tools/bin/sdkmanager")
  ];
  candidates.into_iter().find(|path| path.exists())
}

fn resolve_avdmanager(sdk_root: &Path) -> Option<PathBuf> {
  let candidates = [
    sdk_root.join("cmdline-tools/latest/bin/avdmanager"),
    sdk_root.join("cmdline-tools/bin/avdmanager"),
    sdk_root.join("cmdline-tools/tools/bin/avdmanager"),
    sdk_root.join("tools/bin/avdmanager")
  ];
  candidates.into_iter().find(|path| path.exists())
}

fn resolve_emulator(sdk_root: &Path) -> Option<PathBuf> {
  let path = sdk_root.join("emulator/emulator");
  if path.exists() { Some(path) } else { None }
}

fn resolve_adb(sdk_root: &Path) -> Option<PathBuf> {
  let path = sdk_root.join("platform-tools/adb");
  if path.exists() { Some(path) } else { None }
}

fn list_avds() -> Vec<String> {
  let mut avds = vec![];
  if let Some(home) = home_dir() {
    let avd_dir = home.join(".android/avd");
    if let Ok(entries) = fs::read_dir(avd_dir) {
      for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
          if let Some(name) = path.file_stem().and_then(|v| v.to_str()) {
            if name.ends_with(".avd") {
              avds.push(name.trim_end_matches(".avd").to_string());
            } else {
              avds.push(name.to_string());
            }
          }
        }
      }
    }
  }
  avds.sort();
  avds.dedup();
  avds
}

fn list_android_devices(adb_path: &Path) -> Vec<String> {
  let output = match Command::new(adb_path).arg("devices").output() {
    Ok(output) => output,
    Err(_) => return vec![]
  };
  if !output.status.success() {
    return vec![];
  }
  let stdout = String::from_utf8_lossy(&output.stdout);
  let mut devices = vec![];
  for line in stdout.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("List of devices attached") {
      continue;
    }
    let mut parts = trimmed.split_whitespace();
    let id = match parts.next() {
      Some(id) => id,
      None => continue
    };
    let state = parts.next().unwrap_or("");
    if state == "device" {
      devices.push(id.to_string());
    }
  }
  devices
}

fn resolve_adb_any() -> Option<PathBuf> {
  if let Some(root) = android_sdk_root() {
    if let Some(adb) = resolve_adb(&root) {
      return Some(adb);
    }
  }
  if command_in_path("adb") {
    return Some(PathBuf::from("adb"));
  }
  None
}

fn choose_best_avd(avds: &[String]) -> Option<&String> {
  if avds.is_empty() {
    return None;
  }
  let arch = std::env::consts::ARCH;
  let is_arm = arch == "aarch64" || arch == "arm64";
  for avd in avds {
    if let Some(abi) = avd_abi(avd) {
      let abi_lower = abi.to_lowercase();
      if is_arm && (abi_lower.contains("arm") || abi_lower.contains("aarch64")) {
        return Some(avd);
      }
      if !is_arm && abi_lower.contains("x86") {
        return Some(avd);
      }
    }
  }
  avds.first()
}

fn avd_abi(avd_name: &str) -> Option<String> {
  let config = read_avd_config(avd_name)?;
  config.get("abi.type").cloned().or_else(|| config.get("hw.cpu.arch").cloned())
}

fn read_avd_config(avd_name: &str) -> Option<HashMap<String, String>> {
  let home = home_dir()?;
  let config_path = home.join(format!(".android/avd/{}.avd/config.ini", avd_name));
  let raw = fs::read_to_string(config_path).ok()?;
  let mut map = HashMap::new();
  for line in raw.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
      continue;
    }
    if let Some((key, value)) = trimmed.split_once('=') {
      map.insert(key.trim().to_string(), value.trim().to_string());
    }
  }
  Some(map)
}

fn command_in_path(command: &str) -> bool {
  if cfg!(target_os = "windows") {
    return Command::new("cmd")
      .args(["/C", &format!("where {}", command)])
      .output()
      .map(|output| output.status.success())
      .unwrap_or(false);
  }
  Command::new("sh")
    .arg("-lc")
    .arg(format!("command -v {} >/dev/null 2>&1", command))
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn resolve_java_home() -> Option<PathBuf> {
  if let Ok(home) = std::env::var("JAVA_HOME") {
    if !home.trim().is_empty() {
      let path = PathBuf::from(home);
      if path.join("bin/java").exists() {
        return Some(path);
      }
    }
  }
  if cfg!(target_os = "macos") {
    let system = PathBuf::from("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
    if system.join("bin/java").exists() {
      return Some(system);
    }
    let legacy = PathBuf::from("/Applications/Android Studio.app/Contents/jre/Contents/Home");
    if legacy.join("bin/java").exists() {
      return Some(legacy);
    }
    if let Some(home) = home_dir() {
      let user = home.join("Applications/Android Studio.app/Contents/jbr/Contents/Home");
      if user.join("bin/java").exists() {
        return Some(user);
      }
      let user_legacy = home.join("Applications/Android Studio.app/Contents/jre/Contents/Home");
      if user_legacy.join("bin/java").exists() {
        return Some(user_legacy);
      }
    }
  }
  None
}

fn ensure_java_env(envs: &mut HashMap<String, String>) {
  if envs.contains_key("JAVA_HOME") {
    return;
  }
  if let Some(java_home) = resolve_java_home() {
    envs.insert("JAVA_HOME".to_string(), java_home.to_string_lossy().to_string());
    let base_path = envs
      .get("PATH")
      .cloned()
      .or_else(|| std::env::var("PATH").ok())
      .unwrap_or_default();
    if !base_path.is_empty() {
      envs.insert("PATH".to_string(), format!("{}/bin:{}", java_home.to_string_lossy(), base_path));
    } else {
      envs.insert("PATH".to_string(), format!("{}/bin", java_home.to_string_lossy()));
    }
  }
}

fn ensure_android_env(envs: &mut HashMap<String, String>) -> Option<PathBuf> {
  let sdk_root = if let Some(val) = envs.get("ANDROID_SDK_ROOT").cloned().filter(|v| !v.trim().is_empty()) {
    Some(PathBuf::from(val))
  } else if let Some(val) = envs.get("ANDROID_HOME").cloned().filter(|v| !v.trim().is_empty()) {
    Some(PathBuf::from(val))
  } else {
    android_sdk_root()
  }?;
  let root_str = sdk_root.to_string_lossy().to_string();
  envs.insert("ANDROID_SDK_ROOT".to_string(), root_str.clone());
  envs.insert("ANDROID_HOME".to_string(), root_str);
  Some(sdk_root)
}

fn ensure_android_local_properties(cwd: &Path, sdk_root: &Path) -> Result<(), String> {
  let android_dir = if cwd.join("android").exists() {
    cwd.join("android")
  } else if cwd.ends_with("android") {
    cwd.to_path_buf()
  } else {
    return Ok(());
  };
  let path = android_dir.join("local.properties");
  let sdk_dir = escape_local_properties_path(sdk_root);
  let line = format!("sdk.dir={}", sdk_dir);
  let mut lines: Vec<String> = vec![];
  if let Ok(raw) = fs::read_to_string(&path) {
    lines = raw.lines().map(|l| l.to_string()).collect();
  }
  let mut updated = false;
  for item in &mut lines {
    if item.trim_start().starts_with("sdk.dir=") {
      *item = line.clone();
      updated = true;
      break;
    }
  }
  if !updated {
    lines.push(line);
  }
  let out = format!("{}\n", lines.join("\n"));
  fs::write(&path, out).map_err(|err| err.to_string())?;
  Ok(())
}

fn escape_local_properties_path(path: &Path) -> String {
  path.to_string_lossy()
    .replace('\\', "\\\\")
    .replace(' ', "\\ ")
}

fn ensure_local_cors_env(envs: &mut HashMap<String, String>, command_lower: &str, cwd: &Path) {
  if envs.contains_key("CORS_ORIGIN") {
    return;
  }
  if command_lower.contains("expo run:ios") || command_lower.contains("expo run:android") {
    return;
  }
  let looks_like_server = command_lower.contains("server")
    || command_lower.contains("cd server")
    || command_lower.contains("npm --prefix server")
    || cwd.ends_with("server")
    || cwd.join("server").exists();
  if !looks_like_server {
    return;
  }
  envs.insert("CORS_ORIGIN".to_string(), "http://localhost:5173".to_string());
}

fn ensure_android_cleartext(mobile_dir: &Path, api_url: &str) -> Result<(), String> {
  if !api_url.starts_with("http://") {
    return Ok(());
  }
  let android_dir = mobile_dir.join("android");
  if !android_dir.exists() {
    return Ok(());
  }
  let manifest_path = android_dir.join("app/src/main/AndroidManifest.xml");
  let raw = fs::read_to_string(&manifest_path).map_err(|err| err.to_string())?;
  if raw.contains("usesCleartextTraffic=\"true\"") {
    return Ok(());
  }
  let marker = "<application";
  let pos = raw.find(marker).ok_or_else(|| "AndroidManifest.xml missing <application>".to_string())?;
  let insert_pos = pos + marker.len();
  let updated = format!(
    "{} android:usesCleartextTraffic=\"true\"{}",
    &raw[..insert_pos],
    &raw[insert_pos..]
  );
  fs::write(&manifest_path, updated).map_err(|err| err.to_string())?;
  Ok(())
}

fn xcode_app_installed() -> bool {
  if !cfg!(target_os = "macos") {
    return false;
  }
  let system = PathBuf::from("/Applications/Xcode.app");
  if system.exists() {
    return true;
  }
  home_dir()
    .map(|dir| dir.join("Applications/Xcode.app").exists())
    .unwrap_or(false)
}

fn xcodebuild_version_ok() -> bool {
  if !cfg!(target_os = "macos") {
    return false;
  }
  Command::new("sh")
    .arg("-lc")
    .arg("xcodebuild -version")
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn list_ios_simulators() -> Vec<String> {
  if !cfg!(target_os = "macos") {
    return vec![];
  }
  let output = match Command::new("sh")
    .arg("-lc")
    .arg("xcrun simctl list devices -j")
    .output()
  {
    Ok(output) => output,
    Err(_) => return vec![]
  };
  if !output.status.success() {
    return vec![];
  }
  let raw = String::from_utf8_lossy(&output.stdout).to_string();
  let value: serde_json::Value = match serde_json::from_str(&raw) {
    Ok(value) => value,
    Err(_) => return vec![]
  };
  let devices = match value.get("devices").and_then(|v| v.as_object()) {
    Some(devices) => devices,
    None => return vec![]
  };
  let mut results: Vec<String> = vec![];
  for (runtime, entries) in devices {
    let runtime_label = runtime
      .split('.')
      .last()
      .unwrap_or(runtime)
      .replace('-', " ");
    let list = match entries.as_array() {
      Some(list) => list,
      None => continue
    };
    for item in list {
      let is_available = item.get("isAvailable").and_then(|v| v.as_bool()).unwrap_or(true);
      if !is_available {
        continue;
      }
      let name = match item.get("name").and_then(|v| v.as_str()) {
        Some(name) => name,
        None => continue
      };
      results.push(format!("{} ({})", name, runtime_label));
    }
  }
  results.sort();
  results.dedup();
  results
}

fn list_ios_booted_devices() -> Vec<String> {
  if !cfg!(target_os = "macos") {
    return vec![];
  }
  let output = match Command::new("sh")
    .arg("-lc")
    .arg("xcrun simctl list devices -j")
    .output()
  {
    Ok(output) => output,
    Err(_) => return vec![]
  };
  if !output.status.success() {
    return vec![];
  }
  let raw = String::from_utf8_lossy(&output.stdout).to_string();
  let value: serde_json::Value = match serde_json::from_str(&raw) {
    Ok(value) => value,
    Err(_) => return vec![]
  };
  let devices = match value.get("devices").and_then(|v| v.as_object()) {
    Some(devices) => devices,
    None => return vec![]
  };
  let mut results: Vec<String> = vec![];
  for (runtime, entries) in devices {
    let runtime_label = runtime
      .split('.')
      .last()
      .unwrap_or(runtime)
      .replace('-', " ");
    let list = match entries.as_array() {
      Some(list) => list,
      None => continue
    };
    for item in list {
      let state = item.get("state").and_then(|v| v.as_str()).unwrap_or("");
      if state != "Booted" {
        continue;
      }
      let name = match item.get("name").and_then(|v| v.as_str()) {
        Some(name) => name,
        None => continue
      };
      results.push(format!("{} ({})", name, runtime_label));
    }
  }
  results.sort();
  results.dedup();
  results
}

fn detect_repo_root(base: &Path) -> PathBuf {
  let marker = base.join(".vibes_project.json");
  if let Ok(raw) = fs::read_to_string(&marker) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
      if let Some(root) = value.get("repo_root").and_then(|v| v.as_str()) {
        let root_path = PathBuf::from(root);
        if root_path.exists() {
          return root_path;
        }
      }
    }
  }

  if base.join("package.json").exists() {
    return base.to_path_buf();
  }

  if let Some(found) = find_package_json_dir(base, 3) {
    return found;
  }

  let mut dirs = vec![];
  if let Ok(entries) = fs::read_dir(base) {
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        dirs.push(path);
      }
    }
  }

  if dirs.len() == 1 {
    let child = &dirs[0];
    if child.join("package.json").exists() {
      return child.to_path_buf();
    }
    return child.to_path_buf();
  }

  for dir in &dirs {
    if dir.join("package.json").exists() {
      return dir.to_path_buf();
    }
    if let Ok(entries) = fs::read_dir(dir) {
      for entry in entries.flatten() {
        let nested = entry.path();
        if nested.is_dir() && nested.join("package.json").exists() {
          return nested;
        }
      }
    }
  }

  base.to_path_buf()
}

fn find_package_json_dir(base: &Path, depth: usize) -> Option<PathBuf> {
  if depth == 0 {
    return None;
  }
  if let Ok(entries) = fs::read_dir(base) {
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        if path.join("package.json").exists() {
          return Some(path);
        }
        if let Some(found) = find_package_json_dir(&path, depth - 1) {
          return Some(found);
        }
      }
    }
  }
  None
}

fn pick_command_cwd(command: &str, cwd: Option<PathBuf>) -> Option<PathBuf> {
  let cwd = cwd?;
  let cmd = command.to_lowercase();
  if cmd.contains("expo") {
    let mobile = cwd.join("mobile");
    if mobile.join("package.json").exists() {
      return Some(mobile);
    }
  }
  Some(cwd)
}

#[tauri::command]
fn ensure_project_repo(
  api_base_url: String,
  token: String,
  project_id: String,
  project_name: Option<String>,
  base_dir: Option<String>,
  force: bool
) -> Result<String, String> {
  let base = base_dir
    .filter(|v| !v.trim().is_empty())
    .map(PathBuf::from)
    .unwrap_or_else(default_projects_dir);
  fs::create_dir_all(&base).map_err(|err| err.to_string())?;

  let project_dir = base.join(&project_id);
  if project_dir.exists() {
    if force {
      fs::remove_dir_all(&project_dir).map_err(|err| err.to_string())?;
    } else {
      let root = detect_repo_root(&project_dir);
      return Ok(root.to_string_lossy().to_string());
    }
  }

  fs::create_dir_all(&project_dir).map_err(|err| err.to_string())?;

  let url = format!(
    "{}/projects/{}/repo-download",
    normalize_url(&api_base_url),
    project_id
  );
  let client = Client::new();
  let mut response = client
    .get(url)
    .bearer_auth(token)
    .send()
    .map_err(|err| err.to_string())?;

  if !response.status().is_success() {
    return Err(format!("Download failed: {}", response.status()));
  }

  let archive_path = project_dir.join(format!("{}.tar.gz", project_id));
  let mut archive_file = fs::File::create(&archive_path).map_err(|err| err.to_string())?;
  let mut buffer = Vec::new();
  response
    .read_to_end(&mut buffer)
    .map_err(|err| err.to_string())?;
  archive_file
    .write_all(&buffer)
    .map_err(|err| err.to_string())?;

  let archive_file = fs::File::open(&archive_path).map_err(|err| err.to_string())?;
  let decoder = GzDecoder::new(archive_file);
  let mut archive = Archive::new(decoder);
  archive.unpack(&project_dir).map_err(|err| err.to_string())?;
  let _ = fs::remove_file(&archive_path);

  let root = detect_repo_root(&project_dir);
  let meta = RepoMeta {
    project_id: project_id.clone(),
    project_name,
    repo_root: root.to_string_lossy().to_string(),
    downloaded_at: chrono::Utc::now().to_rfc3339()
  };
  let meta_json = serde_json::to_string_pretty(&meta).map_err(|err| err.to_string())?;
  let meta_path = project_dir.join(".vibes_project.json");
  fs::write(&meta_path, meta_json).map_err(|err| err.to_string())?;

  Ok(root.to_string_lossy().to_string())
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      run_local_command,
      stop_local_runs,
      open_external,
      open_android_studio,
      ensure_project_repo,
      write_mobile_env,
      get_local_lan_ip,
      android_setup_status,
      android_setup_apply,
      android_runtime_status,
      android_launch_emulator,
      android_setup_add_path,
      ios_setup_status,
      ios_runtime_status,
      read_log_tail,
      is_port_open
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
