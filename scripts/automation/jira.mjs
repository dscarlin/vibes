#!/usr/bin/env node
import { Buffer } from 'node:buffer';

function authHeader(config) {
  const token = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(config, pathName, { method = 'GET', body, headers = {}, responseType = 'json' } = {}) {
  const response = await fetch(`${config.jiraBaseUrl}${pathName}`, {
    method,
    headers: {
      Authorization: authHeader(config),
      Accept: 'application/json',
      ...headers
    },
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jira API ${method} ${pathName} failed (${response.status}): ${text}`);
  }
  if (responseType === 'text') return response.text();
  if (responseType === 'buffer') return Buffer.from(await response.arrayBuffer());
  return response.json();
}

export function jiraDocFromText(text) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      type: 'paragraph',
      content: block.split('\n').map((line, index, lines) => ({
        type: 'text',
        text: `${line}${index < lines.length - 1 ? '\n' : ''}`
      }))
    }));
  return {
    version: 1,
    type: 'doc',
    content: paragraphs.length ? paragraphs : [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }]
  };
}

export async function searchIssues(config, jql, fields = []) {
  const payload = await jiraFetch(config, '/rest/api/3/search/jql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jql,
      maxResults: 100,
      fields
    })
  });
  return payload.issues || [];
}

export async function getIssue(config, issueKey, fields = []) {
  const query = fields.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
  return jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}${query}`);
}

export async function getIssueComments(config, issueKey) {
  const payload = await jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
  return payload.comments || [];
}

export async function addComment(config, issueKey, bodyText) {
  return jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: jiraDocFromText(bodyText) })
  });
}

export async function createIssue(config, issueType, summary, descriptionText) {
  return jiraFetch(config, '/rest/api/3/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { key: config.jiraProjectKey },
        issuetype: { name: issueType },
        summary,
        description: jiraDocFromText(descriptionText)
      }
    })
  });
}

export async function listTransitions(config, issueKey) {
  const payload = await jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
  return payload.transitions || [];
}

export async function transitionIssue(config, issueKey, transitionName) {
  const transitions = await listTransitions(config, issueKey);
  const transition = transitions.find(
    (candidate) => String(candidate.name || '').trim().toLowerCase() === String(transitionName || '').trim().toLowerCase()
  );
  if (!transition) {
    throw new Error(`Jira transition "${transitionName}" is not available for ${issueKey}`);
  }
  return jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transition: { id: transition.id } }),
    responseType: 'text'
  });
}

export async function downloadAttachment(config, attachmentUrl) {
  return jiraFetch(config, attachmentUrl.replace(config.jiraBaseUrl, ''), {
    responseType: 'buffer'
  });
}
