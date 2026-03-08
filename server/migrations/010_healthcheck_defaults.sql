update settings
set value = '/'
where key = 'healthcheck_path'
  and (value is null or value = '' or value = '/health');

update settings
set value = '/'
where key in ('healthcheck_path_dev', 'healthcheck_path_test', 'healthcheck_path_prod')
  and (value is null or value = '' or value = '/health');
