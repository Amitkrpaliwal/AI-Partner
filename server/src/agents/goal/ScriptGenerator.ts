/**
 * ScriptGenerator — Builds Python/Node.js prompt templates and cleans LLM output.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

export class ScriptGenerator {

    buildPythonPrompt(goal: string, files: string[], workspace: string, escapedWs: string): string {
        return `You are a code generation expert. Write a COMPLETE, RUNNABLE Python script that fully accomplishes the following goal.

GOAL: ${goal}

FILES TO CREATE:
${files.map(f => `- ${f}`).join('\n')}

WORKSPACE DIRECTORY: ${workspace}

PRE-INSTALLED PACKAGES (no pip install needed — do NOT add pip install commands):
- Data: yfinance, pandas, requests, numpy, beautifulsoup4
- Output: openpyxl, matplotlib, python-docx
- Web: flask, fastapi

REQUIREMENTS:
1. Write a COMPLETE script — no TODO comments, no placeholder functions, no skeleton code
2. Include ALL logic: data fetching, processing, AND output file generation
3. Use os.makedirs(os.path.dirname(path), exist_ok=True) before writing each file
4. Use absolute paths: os.path.join("${escapedWs}", "relative/path")
5. Add try/except around external calls so one failure doesn't abort everything
6. Print progress for long operations: print(f"Processing {item}...")
7. Print "CREATED: <filepath>" for each output file created
8. Import os at the top

CRITICAL: The script MUST produce real output files when executed. A script that prints "TODO: fetch data here" is worthless. Write the actual fetch, the actual processing, the actual file write.
CRITICAL: If the goal mentions sending to telegram/discord/whatsapp, this script CANNOT do that (no bot token available). Instead write a file named "telegram_status.txt" explaining: "Messaging delivery requires the agent to call the messaging_send tool directly. Run the goal again and the agent will call messaging_send with your message content."  Do NOT write a fake telegram_confirmation.txt.
CRITICAL PDF: To generate a PDF, use: subprocess.run(["pandoc", "report.md", "-o", "report.pdf", "--pdf-engine=wkhtmltopdf"], check=True) — both pandoc and wkhtmltopdf are pre-installed.

Output ONLY the Python script. No explanations, no markdown fences, no JSON wrapping.`;
    }

    buildNodePrompt(goal: string, files: string[], workspace: string, escapedWs: string): string {
        return `You are a code generation expert. Write a complete Node.js script that accomplishes the following goal.

GOAL: ${goal}

FILES TO CREATE:
${files.map(f => `- ${f}`).join('\n')}

WORKSPACE DIRECTORY: ${workspace}

REQUIREMENTS:
1. Use const fs = require('fs') and const path = require('path') at the top
2. Use fs.mkdirSync(dir, { recursive: true }) before writing each file
3. Use absolute paths: path.join("${escapedWs}", "relative/path")
4. Write all file content using fs.writeFileSync(filePath, content, 'utf8')
5. The script must be completely self-contained (only use built-in Node.js modules)
6. Generate REAL, functional code - not placeholder or TODO stubs
7. Print "CREATED: <filepath>" for each file created using console.log()

CRITICAL: If the goal mentions sending to telegram/discord/whatsapp, this script CANNOT do that (no bot token available). Instead write a file named "telegram_status.txt" explaining: "Messaging delivery requires the agent to call the messaging_send tool directly. Run the goal again and the agent will call messaging_send with your message content." Do NOT write a fake telegram_confirmation.txt.
CRITICAL PDF: To generate a PDF use: const { execSync } = require('child_process'); execSync('pandoc report.md -o report.pdf --pdf-engine=wkhtmltopdf') — both are pre-installed.

Output ONLY the Node.js script. No explanations, no markdown fences, no JSON wrapping.`;
    }

    /**
     * Clean LLM response to extract just the script code.
     * Strips markdown code fences and trims whitespace.
     */
    cleanScriptResponse(raw: string, runtime: 'python' | 'node' = 'python'): string {
        let script = raw.trim();
        // Strip markdown code fences (python, js, javascript, node variants)
        if (script.startsWith('```python')) script = script.slice(9);
        else if (script.startsWith('```py')) script = script.slice(5);
        else if (script.startsWith('```javascript')) script = script.slice(13);
        else if (script.startsWith('```js')) script = script.slice(5);
        else if (script.startsWith('```node')) script = script.slice(7);
        else if (script.startsWith('```')) script = script.slice(3);
        if (script.endsWith('```')) script = script.slice(0, -3);
        return script.trim();
    }
}
