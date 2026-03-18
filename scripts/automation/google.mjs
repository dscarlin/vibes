#!/usr/bin/env node
import { Buffer } from 'node:buffer';

import { parseCommaList } from './lib.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users';

async function googleFetch(url, { method = 'GET', headers = {}, body, accessToken, responseType = 'json' } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers
    },
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google API ${method} ${url} failed (${response.status}): ${text}`);
  }
  if (responseType === 'buffer') {
    return Buffer.from(await response.arrayBuffer());
  }
  if (responseType === 'text') {
    return response.text();
  }
  return response.json();
}

export async function getGoogleAccessToken(config) {
  if (config.googleAccessToken) return config.googleAccessToken;
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    throw new Error('Google access requires GOOGLE_ACCESS_TOKEN or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN');
  }
  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google token refresh failed (${response.status}): ${text}`);
  }
  const payload = await response.json();
  const token = String(payload.access_token || '').trim();
  if (!token) throw new Error('Google token refresh did not return access_token');
  return token;
}

export async function listDriveAudioFiles(config) {
  const accessToken = await getGoogleAccessToken(config);
  const q = [
    `'${config.driveFolderId}' in parents`,
    'trashed = false'
  ].join(' and ');
  const url = new URL(`${GOOGLE_DRIVE_API}/files`);
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,createdTime,fileExtension,md5Checksum,size)');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  const payload = await googleFetch(url.toString(), { accessToken });
  const supportedExtensions = new Set(['mp3', 'm4a', 'wav', 'mp4']);
  return (payload.files || []).filter((file) => supportedExtensions.has(String(file.fileExtension || '').toLowerCase()));
}

export async function downloadDriveFile(config, fileId) {
  const accessToken = await getGoogleAccessToken(config);
  const url = new URL(`${GOOGLE_DRIVE_API}/files/${fileId}`);
  url.searchParams.set('alt', 'media');
  return googleFetch(url.toString(), { accessToken, responseType: 'buffer' });
}

function encodeBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function extractMessageTextFromPayload(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (!Array.isArray(payload.parts)) return '';
  return payload.parts
    .map((part) => extractMessageTextFromPayload(part))
    .filter(Boolean)
    .join('\n');
}

export async function sendGmailMessage(config, { to, cc = [], subject, bodyText, threadId = '' }) {
  const accessToken = await getGoogleAccessToken(config);
  const recipients = parseCommaList(Array.isArray(to) ? to.join(',') : to);
  const ccRecipients = parseCommaList(Array.isArray(cc) ? cc.join(',') : cc);
  const rawMessage = [
    `To: ${recipients.join(', ')}`,
    ccRecipients.length ? `Cc: ${ccRecipients.join(', ')}` : '',
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText
  ]
    .filter(Boolean)
    .join('\r\n');
  const payload = {
    raw: encodeBase64Url(rawMessage)
  };
  if (threadId) payload.threadId = threadId;
  return googleFetch(`${GOOGLE_GMAIL_API}/${config.googleUser}/messages/send`, {
    method: 'POST',
    accessToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function fetchGmailThread(config, threadId) {
  const accessToken = await getGoogleAccessToken(config);
  const thread = await googleFetch(`${GOOGLE_GMAIL_API}/${config.googleUser}/threads/${threadId}?format=full`, { accessToken });
  return {
    ...thread,
    normalizedText: (thread.messages || [])
      .map((message) => {
        const snippet = String(message.snippet || '').trim();
        const body = extractMessageTextFromPayload(message.payload);
        return [snippet, body].filter(Boolean).join('\n');
      })
      .filter(Boolean)
      .join('\n\n---\n\n')
  };
}
