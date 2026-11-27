// A separate build entry, emitted beside the module that starts it. From source the thread
// is started through the tsx loader, which resolves this import to the TypeScript file.
await import("./pack-worker-job.js");
