# Agents

## Main Assistant
- id: main
- name: Mindful Assistant
- model: gemini-2.0-flash-exp
- temperature: 0.7
- system_prompt_file: SOUL.md
- skills:
  - file-ops
  - web-search
  - code-exec
  - gmail
  - calendar
  - browser

## Coding Assistant
- id: coder
- name: Coding Assistant
- model: gemini-2.0-flash-exp
- temperature: 0.3
- specialization: "Code generation and debugging"
- skills:
  - file-ops
  - code-exec
  - terminal
