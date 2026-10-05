function nativeRequestGetter(name: string): ((this: Request) => unknown) | undefined {
	let prototype: object | null = Request.prototype;
	while (prototype !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor) return descriptor.get;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
}
const requestGetters = Object.freeze({
	method: nativeRequestGetter("method"),
	url: nativeRequestGetter("url"),
	headers: nativeRequestGetter("headers"),
});
const headersGet = Headers.prototype.get;
export function snapshotBrowserRoute(request: Request) {
	const method = requestGetters.method?.call(request);
	const url = requestGetters.url?.call(request);
	if (typeof method !== "string" || typeof url !== "string") throw new Error();
	return Object.freeze({ method, url });
}

export function snapshotBrowserRequest(request: Request) {
	const route = snapshotBrowserRoute(request);
	const headers = requestGetters.headers?.call(request) as Headers;
	return Object.freeze({ ...route, cookie: headersGet.call(headers, "cookie") });
}
