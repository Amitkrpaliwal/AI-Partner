export interface Reflection {
    rootCause: string;
    reasoning: string;
    proposedFix: {
        type: 'retry' | 'skip' | 'abort';
        description: string;
    };
    confidence: number;
}
