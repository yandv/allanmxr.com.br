interface Env {
  ASSETS: Fetcher;
}

type Lang = 'pt' | 'en';

const legacyPaths: Record<string, string> = {
  '/curriculo': '/resume',
  '/allan-marcelino-curriculo.pdf': '/allan-marcelino-resume-pt.pdf',
  '/allan-marcelino-resume.pdf': '/allan-marcelino-resume-en.pdf',
};

const redirect = (url: URL, status: number, lang?: Lang) => {
  const headers = new Headers({ Location: url.href });
  if (lang) headers.set('Set-Cookie', `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return new Response(null, { status, headers });
};

const preferredLang = (request: Request): Lang => {
  const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)lang=(pt|en)(?:;|$)/)?.[1];
  if (cookie === 'pt' || cookie === 'en') return cookie;
  const accept = request.headers.get('Accept-Language')?.trim().toLowerCase();
  return !accept || accept.startsWith('*') || accept.startsWith('pt') ? 'pt' : 'en';
};

const fetchPage = async (request: Request, env: Env, lang: Lang): Promise<{ lang: Lang; response: Response }> => {
  if (lang === 'pt') return { lang, response: await env.ASSETS.fetch(request) };
  const internal = new URL(request.url);
  internal.pathname = internal.pathname === '/' ? '/en' : `/en${internal.pathname}`;
  const english = await env.ASSETS.fetch(new Request(internal, request));
  if (english.status !== 404 && !english.headers.has('Location')) return { lang, response: english };
  const portuguese = await env.ASSETS.fetch(request);
  return portuguese.status === 404 ? { lang, response: english } : { lang: 'pt', response: portuguese };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'curriculum.allanmxr.com.br') return redirect(new URL('https://allanmxr.com.br/resume'), 301);

    const chosen = url.searchParams.get('lang');
    if (chosen === 'pt' || chosen === 'en') {
      url.searchParams.delete('lang');
      return redirect(url, 302, chosen);
    }

    const legacyPath = legacyPaths[url.pathname];
    if (legacyPath) {
      url.pathname = legacyPath;
      return redirect(url, 301);
    }

    const prefixed = url.pathname.match(/^\/en(\/.*)?$/);
    if (prefixed) {
      url.pathname = prefixed[1] ?? '/';
      return redirect(url, 301, 'en');
    }

    if (/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(request);

    const page = await fetchPage(request, env, preferredLang(request));
    const response = new Response(page.response.body, page.response);
    response.headers.set('Content-Language', page.lang === 'en' ? 'en' : 'pt-BR');
    response.headers.set('Vary', 'Cookie, Accept-Language');
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return response;
  },
} satisfies ExportedHandler<Env>;
