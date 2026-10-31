// Load the auth provider before the router reads the URL: a sign-in redirect
// lands on `/?code=…` and the provider puts back the page it started from.
import '$auth';
