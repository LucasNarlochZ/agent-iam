declare module "tau-prolog" {
    interface SessionOptions {
        success?: (value: unknown) => void;
        error?: (error: unknown) => void;
        fail?: () => void;
        limit?: () => void;
    }

    interface Session {
        consult(program: string, options: SessionOptions): void;
        query(goal: string, options: SessionOptions): void;
        answer(options: SessionOptions): void;
        format_answer(answer: unknown): string;
    }

    const pl: { create(limit?: number): Session };
    export default pl;
}
