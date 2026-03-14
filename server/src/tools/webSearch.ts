import { search, SafeSearchType } from 'duck-duck-scrape';

export class WebSearchTool {

  async search(query: string): Promise<string> {
    try {
      const results = await search(query, {
        safeSearch: SafeSearchType.MODERATE
      });

      if (!results.results || results.results.length === 0) {
        return "No results found.";
      }

      // Format results for the LLM
      return results.results.slice(0, 5).map((r: any) =>
        `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.description}`
      ).join('\n\n');

    } catch (error) {
      console.error('Web Search Error:', error);
      // Return a soft error so the plan implies "Continue with internal knowledge"
      return `[WARNING] Web Search failed (Network/API Error). Proceed using your internal knowledge and best practices.`;
    }
  }
}
