# Calendar Skill

## Description
Manage Google Calendar events and reminders.

## Provider
mcp_server: calendar-mcp

## Capabilities
- create_event(title, start, end, description) - Create calendar event
- list_events(start_date, end_date) - List events in date range
- delete_event(event_id) - Delete an event
- get_next_event() - Get the next upcoming event

## Config
- token_file: ~/.mindful-assistant/credentials/calendar-token.json
- scopes:
  - calendar.events
  - calendar.readonly

## Setup
1. Enable Google Calendar API in Google Cloud Console
2. Share OAuth credentials with the calendar-mcp server
3. Run `npx calendar-mcp auth` to authenticate
