/*
 * The server has no authentication: bound to a loopback address, being out of
 * reach of other machines is all that protects the repository. A web page can
 * still get in by rebinding its own domain to 127.0.0.1 - but the browser then
 * sends that domain as the Host header, which is how it is told apart.
 */

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/* Whether `host` is an address only this machine can reach. */
export const isLoopback = host => LOOPBACK_HOSTS.includes(host);

/* Whether a Host header names this server: a loopback name, on this port. */
export const isLocalHostHeader = (header, port) =>
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(header).toLowerCase());

/* Middleware answering 403 to any request addressed to another name. */
export const requireLocalHost = port => (req, res, next) => {
    if (isLocalHostHeader(req.headers.host, port)) {
        return next();
    }
    res.status(403).type('text/plain').send('srcblocks only answers requests addressed to localhost');
};
