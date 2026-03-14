The current approach is not working. We need a new strategy.

ORIGINAL GOAL: {{GOAL}}

WHAT WE'VE TRIED:
{{FAILED_APPROACHES}}

CURRENT STATE:
- Files created: {{ARTIFACTS}}
- Criteria passed: {{CRITERIA_PASSED}}
- Criteria failing: {{CRITERIA_FAILING}}
- Blocking issues: {{BLOCKING_ISSUES}}

Create a NEW approach that avoids previous failures.

Output JSON:
{
  "new_strategy": "Description of new approach",
  "first_action": {
    "tool": "tool_name",
    "args": {}
  },
  "why_different": "How this avoids previous failures"
}
