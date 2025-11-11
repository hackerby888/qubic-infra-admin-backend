export async function promiseTimeout<T>(
    ms: number,
    promise: Promise<T>
): Promise<T> {
    // Create a promise that rejects in <ms> milliseconds
    let timeout = new Promise<T>((_, reject) => {
        let id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error("Timed out in " + ms + "ms."));
        }, ms);
    });

    return Promise.race([promise, timeout]);
}
