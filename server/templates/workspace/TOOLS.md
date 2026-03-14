# Tools

## file-ops
Built-in file operations for the workspace.
- read_file(path) - Read contents of a file
- write_file(path, content) - Write content to a file
- list_directory(path) - List files in a directory
- delete_file(path) - Delete a file (requires confirmation)

## web-search
Search the web and fetch content.
- search_web(query, limit) - Search using DuckDuckGo
- fetch_url(url) - Fetch and parse webpage content

## code-exec
Execute code in a sandboxed environment.
- run_python(code) - Run Python code
- run_javascript(code) - Run JavaScript code
- run_shell(command) - Run shell command (requires confirmation)

## terminal
Execute terminal commands in the workspace.
- run_command(command) - Run a CLI command
- npm_run(script) - Run npm script
- git(args) - Run git command

## browser
Browser automation using Playwright.
- open_url(url) - Open a URL in browser
- click(selector) - Click an element
- fill(selector, value) - Fill form field
- screenshot() - Take a screenshot
