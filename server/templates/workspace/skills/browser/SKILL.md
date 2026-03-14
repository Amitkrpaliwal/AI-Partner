---
name: Browser Automation
description: Control a web browser for navigation, form filling, data extraction, and screenshots
provider: builtin
providerType: builtin
version: 1.0.0
config:
  defaultTimeout: 30000
  headless: true
---

# Browser Automation Skill

Automate web browser interactions using Playwright for navigation, form filling, data extraction, and screenshots.

## Prerequisites

Playwright must be installed for browser automation to work:
```bash
npm install playwright
npx playwright install chromium
```

## Available Tools

### browser_launch
Start a browser session. Must be called before other browser operations.

**Parameters:**
- `headless` (optional): Run in headless mode (default: true)

**Example:**
```
browser_launch({ headless: true })
browser_launch({ headless: false }) // Show browser window for debugging
```

### browser_navigate
Navigate to a URL in the browser.

**Parameters:**
- `url` (required): The URL to navigate to
- `waitUntil` (optional): Wait condition - 'load', 'domcontentloaded', 'networkidle'

**Example:**
```
browser_navigate({ url: "https://example.com" })
browser_navigate({ url: "https://example.com/form", waitUntil: "networkidle" })
```

### browser_click
Click an element on the page.

**Parameters:**
- `selector` (required): CSS selector for the element
- `timeout` (optional): Timeout in ms (default: 30000)

**Example:**
```
browser_click({ selector: "#submit-button" })
browser_click({ selector: "button.primary", timeout: 5000 })
```

### browser_fill
Fill text into an input field.

**Parameters:**
- `selector` (required): CSS selector for the input
- `value` (required): Text to enter
- `timeout` (optional): Timeout in ms

**Example:**
```
browser_fill({ selector: "input[name='email']", value: "user@example.com" })
browser_fill({ selector: "#password", value: "secure123" })
```

### browser_extract
Extract text or attribute from element(s).

**Parameters:**
- `selector` (required): CSS selector
- `attribute` (optional): Attribute to extract (default: textContent)
- `all` (optional): Extract from all matching elements

**Example:**
```
browser_extract({ selector: "h1" })  // Get page title
browser_extract({ selector: "a.link", attribute: "href", all: true })  // Get all links
```

### browser_screenshot
Take a screenshot of the page or element.

**Parameters:**
- `path` (optional): File path to save (returns base64 if not provided)
- `fullPage` (optional): Capture full page (default: false)
- `selector` (optional): Screenshot specific element

**Example:**
```
browser_screenshot({ path: "./screenshot.png" })
browser_screenshot({ fullPage: true, path: "./full-page.png" })
browser_screenshot({ selector: "#chart" })  // Returns base64
```

### browser_eval
Execute JavaScript in the page context.

**Parameters:**
- `script` (required): JavaScript code to execute

**Example:**
```
browser_eval({ script: "document.title" })
browser_eval({ script: "window.scrollTo(0, document.body.scrollHeight)" })
```

### browser_wait
Wait for an element to appear or change state.

**Parameters:**
- `selector` (required): CSS selector
- `timeout` (optional): Timeout in ms (default: 30000)
- `state` (optional): 'attached', 'detached', 'visible', 'hidden'

**Example:**
```
browser_wait({ selector: "#loading", state: "hidden" })
browser_wait({ selector: ".results", state: "visible" })
```

### browser_get_content
Get the full HTML content of the current page.

**Example:**
```
browser_get_content({})
```

### browser_close
Close the browser session.

**Example:**
```
browser_close({})
```

## Typical Workflow

1. Launch browser: `browser_launch()`
2. Navigate to page: `browser_navigate({ url: "..." })`
3. Fill form: `browser_fill({ selector: ..., value: ... })`
4. Click submit: `browser_click({ selector: "button[type=submit]" })`
5. Wait for result: `browser_wait({ selector: ".result", state: "visible" })`
6. Extract data: `browser_extract({ selector: ".result" })`
7. Close browser: `browser_close()`

## HITL Considerations

Browser actions that navigate to unknown domains or submit forms with sensitive data will require Human-In-The-Loop approval.
