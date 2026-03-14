# Gmail Skill

## Description
Send and read emails for the user.

## Provider
mcp_server: gmail-mcp

## Capabilities
- send_email(to, subject, body) - Send an email
- list_recent(limit) - List recent emails
- search(query, limit) - Search emails by query

## Config
- token_file: ~/.mindful-assistant/credentials/gmail-token.json
- scopes:
  - gmail.send
  - gmail.readonly

## Setup
1. Enable Gmail API in Google Cloud Console
2. Download OAuth credentials
3. Run `npx gmail-mcp auth` to authenticate
4. Token will be saved to the token_file path
