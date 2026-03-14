import { ContainerSandbox, ExecutionResult } from './containerSandbox';

export class SandboxTool {
  private container: ContainerSandbox;

  constructor(workspacePath: string = process.cwd()) {
    this.container = new ContainerSandbox(workspacePath);
  }

  async execute(language: 'python' | 'javascript', code: string): Promise<string> {
    let result: string | ExecutionResult;
    if (language === 'python') {
      result = await this.container.executePython(code);
    } else {
      result = await this.container.executeJavaScript(code);
    }

    // Handle both string (error message) and ExecutionResult returns
    if (typeof result === 'string') {
      return result;
    }

    if (!result.success) {
      return `Error (Exit ${result.exitCode}):\n${result.stderr || result.stdout}`;
    }

    return result.stdout || '(No output)';
  }
}
