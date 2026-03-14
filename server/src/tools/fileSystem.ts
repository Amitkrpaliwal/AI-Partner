import fs from 'fs/promises';
import path from 'path';

export class FileSystemTool {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  setRoot(newPath: string) {
    this.workspaceRoot = path.resolve(newPath);
    console.log(`[FileSystem] Workspace root changed to: ${this.workspaceRoot}`);
  }

  /**
   * List files in a directory (non-recursive for safety by default)
   */
  async listFiles(dirPath: string = '.'): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    try {
      const files = await fs.readdir(fullPath);
      return files;
    } catch (error) {
      throw new Error(`Failed to list files: ${error}`);
    }
  }

  /**
   * Read file content
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolvePath(filePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  }

  /**
   * Write file content
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(filePath);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write file: ${error}`);
    }
  }

  /**
   * Security: Ensure path is within workspace
   */
  private resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Access denied: Path traversal detected. ${resolved}`);
    }
    return resolved;
  }
}
