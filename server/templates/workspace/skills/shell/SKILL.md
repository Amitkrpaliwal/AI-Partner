---
name: Shell Execution
description: Execute shell commands, scripts, and CLI tools in the workspace with security controls
provider: builtin
providerType: builtin
version: 1.0.0
config:
  allowedCommands:
    - npm
    - npx
    - node
    - git
    - python
    - pip
    - tsc
    - eslint
  maxTimeout: 60000
  maxConcurrent: 3
---

# Shell Execution Skill

Execute shell commands safely within the workspace directory.

## Available Tools

### run_command
Execute a shell command in the workspace.

**Parameters:**
- `command` (required): The command to execute (e.g., "npm install axios")
- `cwd` (optional): Working directory relative to workspace root
- `timeout` (optional): Timeout in milliseconds (default: 60000)

**Example:**
```
run_command({ command: "npm install axios" })
run_command({ command: "git status" })
run_command({ command: "node build.js", timeout: 120000 })
```

### list_processes
List currently running shell commands.

### kill_process
Kill a running command by its ID.

**Parameters:**
- `processId` (required): The process ID to kill

## Security Controls

1. **Command Allowlist**: Only approved commands can be executed
2. **Workspace Sandboxing**: Commands can only run within the workspace
3. **HITL Approval**: Dangerous commands require user approval
4. **Timeout**: Commands are killed after timeout (default 60s)
5. **Output Limits**: Max 1MB output to prevent memory issues

## Allowed Commands

The following command prefixes are allowed by default:
- Package managers: `npm`, `npx`, `yarn`, `pnpm`, `pip`
- Runtimes: `node`, `python`, `deno`, `bun`
- Version control: `git`
- Build tools: `tsc`, `eslint`, `prettier`, `jest`
- File operations: `ls`, `cat`, `echo`, `mkdir`, `find`, `grep`

## Safety Notes

- All commands are sandboxed to the current workspace directory
- Path traversal attempts (../) are blocked
- Destructive system commands (rm -rf /, format) are blocked
- Privilege escalation (sudo, su) is blocked
