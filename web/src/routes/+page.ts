import { redirect } from '@sveltejs/kit';

export function load({ url }) {
  throw redirect(307, `/dashboard${url.search}`); // keeps ?db=
}
