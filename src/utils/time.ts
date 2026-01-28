export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function millisToSeconds(ms: number): number {
    return Number((ms / 1000).toFixed(2));
}

export function getLastWednesdayTimestamp() {
    const now = new Date();

    // Get current day of week (0 = Sunday, 1 = Monday, ..., 3 = Wednesday, etc.)
    const dayOfWeek = now.getUTCDay();

    // Calculate how many days ago the last Wednesday was
    // If today is Wednesday, this will return 7 (to get the *previous* one) if current time is past 12:00 UTC
    // or 0 (to get today) if current time is before 12:00 UTC
    let daysSinceLastWednesday = (dayOfWeek + 4) % 7;
    if (daysSinceLastWednesday === 0 && now.getUTCHours() < 12) {
        // If today is Wednesday and before 12:00 UTC, go back 7 days to get the previous Wednesday
        daysSinceLastWednesday = 7;
    }

    // Create a new date object for that day
    const lastWednesday = new Date(now);
    lastWednesday.setUTCDate(now.getUTCDate() - daysSinceLastWednesday);

    // Set time to exactly 12:00:00.000 UTC
    lastWednesday.setUTCHours(12, 0, 0, 0);

    return {
        iso: lastWednesday.toISOString(),
        timestamp: lastWednesday.getTime(), // Milliseconds
    };
}
