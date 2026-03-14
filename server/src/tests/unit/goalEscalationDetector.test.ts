/**
 * GoalEscalationDetector unit tests (Phase 3.3 extraction)
 *
 * Both scoreForGoalEscalation and lastMessageIsTaskContext are pure functions —
 * no mocking required.
 */
import { describe, it, expect } from 'vitest';
import { scoreForGoalEscalation, lastMessageIsTaskContext } from '../../services/GoalEscalationDetector';

// ─────────────────────────────────────────────────────────────────────────────
// lastMessageIsTaskContext
// ─────────────────────────────────────────────────────────────────────────────

describe('lastMessageIsTaskContext', () => {
    it('returns true for goal completion report (old format ✓)', () => {
        expect(lastMessageIsTaskContext('✓ Completed — I downloaded the file')).toBe(true);
    });

    it('returns true for iteration/executing signals', () => {
        expect(lastMessageIsTaskContext('executing step 3 of 5')).toBe(true);
    });

    it('returns true for HITL pause (⏸)', () => {
        expect(lastMessageIsTaskContext('⏸ Task paused — Action Required: please log in')).toBe(true);
    });

    it('returns true for new format ✅ Done', () => {
        expect(lastMessageIsTaskContext('✅ Done\n2 of 3 steps done')).toBe(true);
    });

    it('returns true for new format ⚠️ Almost there', () => {
        expect(lastMessageIsTaskContext('⚠️ Almost there — 1 criterion still pending')).toBe(true);
    });

    it('returns true for retry tip', () => {
        expect(lastMessageIsTaskContext('Type "retry" to fix automatically')).toBe(true);
    });

    it('returns false for a normal chat response', () => {
        expect(lastMessageIsTaskContext('Sure! Here is a simple Python function to sort a list.')).toBe(false);
    });

    it('returns false for an empty string', () => {
        expect(lastMessageIsTaskContext('')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreForGoalEscalation
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreForGoalEscalation', () => {
    it('scores >= 4 for a message with an explicit output file', () => {
        const score = scoreForGoalEscalation('Generate a report and save it as report.pdf');
        expect(score).toBeGreaterThanOrEqual(4);
    });

    it('scores >= 4 for a short follow-up after active task context', () => {
        const score = scoreForGoalEscalation(
            'what went wrong?',
            '✅ Done\n2 of 3 steps done\nType "retry" to fix automatically'
        );
        expect(score).toBeGreaterThanOrEqual(4);
    });

    it('scores 0 for a trivial single-word question', () => {
        const score = scoreForGoalEscalation('hello');
        expect(score).toBe(0);
    });

    it('scores >= 3 for create + research combination', () => {
        const score = scoreForGoalEscalation('Research the top 5 stocks and create an analysis');
        expect(score).toBeGreaterThanOrEqual(3);
    });

    it('scores >= 4 for multi-step connector + file', () => {
        const score = scoreForGoalEscalation('Find the latest prices and then save them to data.json');
        expect(score).toBeGreaterThanOrEqual(4);
    });

    it('scores >= 2 for explicit multi-domain (stock + api)', () => {
        const score = scoreForGoalEscalation('Fetch stock data from an api and save to a dashboard excel file');
        expect(score).toBeGreaterThanOrEqual(2);
    });

    it('does NOT boost score for long last message that is not task context', () => {
        const longNonTask = 'Sure, I can help you with that! Python is a great language for data science.';
        const score = scoreForGoalEscalation('ok thanks', longNonTask);
        // short follow-up but last message is NOT task context → no boost
        expect(score).toBe(0);
    });
});
