const networkCodes = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EADDRINUSE']);
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && (networkCodes.has(code) || /^[0-9A-Z]{5}$/.test(code)) ? code : 'internal_error';
}
/** Do not serialize raw URL/query, headers, body, error text/stack or PG detail.
 * Route templates and the server-generated request id are sufficient correlation.
 */
export const safeLogSerializers = {
  req(request: {method?:string;routeOptions?:{url?:string}}) {
    return {method:request.method,route:request.routeOptions?.url??'unresolved'};
  },
  res(response: {statusCode?:number}) { return {statusCode:response.statusCode}; },
  err(error: unknown) { return {type:'Error',message:'Request failed',stack:'',code:safeErrorCode(error)}; },
};
