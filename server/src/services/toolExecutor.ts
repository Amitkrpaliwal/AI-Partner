import { FileSystemTool } from '../tools/fileSystem';
import { WebSearchTool } from '../tools/webSearch';
import { SandboxTool } from '../tools/sandbox';
import { modelManager } from './llm/modelManager';

interface ToolResult {
  success: boolean;
  output: string;
}

export class ToolExecutor {
  private fs: FileSystemTool;
  private web: WebSearchTool;
  private sandbox: SandboxTool;

  constructor(workspaceRoot: string) {
    this.fs = new FileSystemTool(workspaceRoot);
    this.web = new WebSearchTool();
    this.sandbox = new SandboxTool();
  }

  async executeStep(step: any): Promise<ToolResult> {
    const llm = modelManager.getActiveAdapter();
    if (!llm) {
      return { success: false, output: "No active LLM adapter found." };
    }

    try {
      const toolPrompt = `
        You are an executor. Convert this step into a specific tool call.
        Step: "${step.description}"
        
        Available Tools:
        - file_write(path: string, content: string)
        - file_read(path: string)
        - list_files(path: string)
        - web_search(query: string)
        - run_python(code: string)
        - run_js(code: string)
        
        Return JSON:
        {
          "tool": "file_write" | "file_read" | "list_files" | "web_search" | "run_python" | "run_js",
          "args": { ... }
        }
      `;

      const instruction = await llm.generateJSON(toolPrompt, {});

      console.log(`[ToolExecutor] Executing ${instruction.tool}`, instruction.args);

      switch (instruction.tool) {
        case 'web_search':
          const results = await this.web.search(instruction.args.query);
          return { success: true, output: results };

        case 'file_write':
          let content = instruction.args.content;
          if (!content || content === 'TODO') {
            content = await llm.generate(`Generate content for file ${instruction.args.path} based on: ${step.description}`);
          }
          await this.fs.writeFile(instruction.args.path, content);
          return { success: true, output: `Wrote file ${instruction.args.path}` };

        case 'file_read':
          const data = await this.fs.readFile(instruction.args.path);
          return { success: true, output: data };

        case 'list_files':
          const files = await this.fs.listFiles(instruction.args.path || '.');
          return { success: true, output: files.join(', ') };

        case 'run_python':
          const pyOut = await this.sandbox.execute('python', instruction.args.code);
          return { success: true, output: pyOut };

        case 'run_js':
          const jsOut = await this.sandbox.execute('javascript', instruction.args.code);
          return { success: true, output: jsOut };

        default:
          return { success: false, output: `Unknown tool: ${instruction.tool}` };
      }

    } catch (error) {
      console.error('[ToolExecutor] Error:', error);
      return { success: false, output: String(error) };
    }
  }
}
