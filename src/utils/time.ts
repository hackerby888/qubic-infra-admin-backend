export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function millisToSeconds(ms: number): number {
    return Number((ms / 1000).toFixed(2));
}
