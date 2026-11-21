import type { Text } from '../i18n/ui';

export const profile = {
  name: 'Allan Marcelino de Souza',
  shortName: 'Allan Marcelino',
  role: { pt: 'Engenheiro de Software Sênior', en: 'Senior Software Engineer' },
  summary: {
    pt: 'Engenheiro de Software Sênior com mais de 4 anos de experiência construindo sistemas de ponta a ponta, de APIs e bancos de dados a front-end e infraestrutura. Hoje construo produtos SaaS sobre Cloudflare Workers e PostgreSQL na Great Softwares, com edição colaborativa em tempo real, agentes de IA, registro de domínios e cobrança recorrente. Antes, desenvolvi APIs em NestJS e Spring integradas ao SAP para clientes industriais, fluxos de identidade e acesso em Azure e OpenShift e análises de dados de saúde pública na Fiocruz. Bacharel em Ciência da Computação pela UFRRJ, com pós-graduação em Ciência de Dados.',
    en: 'Senior Software Engineer with more than 4 years of experience building systems end to end, from APIs and databases to front-end and infrastructure. At Great Softwares I build SaaS products on Cloudflare Workers and PostgreSQL, with real time collaborative editing, AI agents, domain registration and recurring billing. Before that, I developed NestJS and Spring APIs integrated with SAP for industrial clients, identity and access flows on Azure and OpenShift, and public health data analysis at Fiocruz. BSc in Computer Science from UFRRJ, with a graduate program in Data Science.',
  },
  city: 'Barueri',
  region: 'SP',
  email: 'allanmxr@gmail.com',
  links: {
    linkedin: 'https://www.linkedin.com/in/allanmxr',
    github: 'https://github.com/yandv',
    apify: 'https://apify.com/allanmxr',
  },
};

interface Work {
  company: string;
  slug: string;
  products: Text;
  period: Text;
  summary: Text;
  highlights: Text[];
  stack: string[];
}

export const job: Work = {
  company: 'Great Softwares',
  slug: 'great-softwares',
  products: { pt: 'Great Pages, Great Apps e Great Domains', en: 'Great Pages, Great Apps and Great Domains' },
  period: { pt: 'Fev 2026 até hoje', en: 'Feb 2026 to present' },
  summary: {
    pt: 'Construo os produtos de ponta a ponta, da API ao editor visual. Editor de páginas com IA e edição colaborativa em tempo real, servidor MCP para agentes controlarem páginas, blog, quiz e slides, o Great Domains do zero (inclusive domínios .br via EPP) e billing com Pix recorrente, cartão e afiliados.',
    en: 'I build the products end to end, from the API to the visual editor. An AI page editor with real time collaborative editing, an MCP server so agents can control pages, blog, quiz and slides, Great Domains from scratch (including .br domains over EPP) and billing with recurring Pix, cards and affiliates.',
  },
  highlights: [
    { pt: 'Multiplayer em tempo real com Durable Objects e WebSocket', en: 'Real time multiplayer with Durable Objects and WebSocket' },
    { pt: 'Registro de domínios com OpenSRS e Registro.br', en: 'Domain registration with OpenSRS and Registro.br' },
    { pt: '2FA, SSO e rate limit no acesso', en: '2FA, SSO and rate limiting on sign in' },
  ],
  stack: ['Hono', 'Cloudflare Workers', 'Durable Objects', 'PostgreSQL', 'Kysely', 'Next.js', 'TanStack Start'],
};

export const sideProjects: Work[] = [
  {
    company: 'Araute',
    slug: 'araute',
    products: { pt: 'Plataforma de pagamentos', en: 'Payments platform' },
    period: { pt: 'Jul 2026 até hoje', en: 'Jul 2026 to present' },
    summary: {
      pt: 'API pública de pagamentos para lojistas: Pix, Pix Automático, boleto e cartão, assinaturas, links de pagamento e emissão de NFS-e com custódia isolada do certificado A1. Como tech lead, cuido da arquitetura e atuo no backend, no painel do lojista, na documentação pública e no SDK.',
      en: 'A public payments API for merchants: Pix, Pix Automático, boleto and cards, subscriptions, payment links and NFS-e invoicing with isolated custody of the A1 certificate. As tech lead, I own the architecture and work on the backend, the merchant dashboard, the public docs and the SDK.',
    },
    highlights: [
      { pt: 'API versionada com sandbox e webhooks', en: 'Versioned API with sandbox and webhooks' },
      { pt: 'Pix Automático com mandatos e retentativas', en: 'Pix Automático with mandates and retries' },
      { pt: 'NFS-e nacional e de São Paulo', en: 'National and São Paulo NFS-e' },
      { pt: 'SDK @araute/js e design system próprio', en: '@araute/js SDK and in-house design system' },
    ],
    stack: ['Hono', 'Kysely', 'Zod', 'Workers', 'Queues', 'TanStack Start', 'Playwright'],
  },
  {
    company: 'Salte',
    slug: 'salte',
    products: { pt: 'ERP para clínicas', en: 'ERP for clinics' },
    period: { pt: 'Fev 2026 até hoje', en: 'Feb 2026 to present' },
    summary: {
      pt: 'ERP para clínicas, multi-tenant e whitelabel: agenda e recepção, prontuário e documentos com assinatura digital, financeiro e repasse a profissionais, conta bancária com Pix e boleto, convênios, estoque, cobrança da assinatura e app mobile, com uma camada de IA clínica que cita a fonte. Sou tech lead: arquitetura, decisões técnicas e mão no código.',
      en: 'A multi-tenant, whitelabel ERP for clinics: scheduling and front desk, patient records and documents with digital signatures, finance and professional payouts, a bank account with Pix and boleto, health insurance billing, inventory, subscription billing and a mobile app, with a clinical AI layer that cites its sources. I am the tech lead: architecture, technical decisions and hands on code.',
    },
    highlights: [
      { pt: 'Multi-tenant por clínica e whitelabel por marca', en: 'Multi-tenant per clinic and whitelabel per brand' },
      { pt: 'Financeiro, repasse em lotes e conta bancária via Woovi com PIN transacional', en: 'Finance, batch payouts and a bank account via Woovi with a transaction PIN' },
      { pt: 'Faturamento de convênios e app mobile', en: 'Health insurance billing and a mobile app' },
      { pt: 'IA clínica com fonte citada e abstenção segura', en: 'Clinical AI with cited sources and safe abstention' },
    ],
    stack: ['Hono', 'Cloudflare Workers', 'PostgreSQL', 'Hyperdrive', 'TanStack Start', 'Expo', 'LLMs'],
  },
];

export const sideProjectsNote: Text = {
  pt: 'Araute e Salte são da mesma empresa, fundada pelo CTO da Great. Trabalho nelas como projeto paralelo, fora do meu emprego na Great.',
  en: "Araute and Salte belong to the same company, founded by Great's CTO. I work on them as side projects, outside my job at Great.",
};

interface Stage {
  year: string;
  title: Text;
  role: Text;
  text: Text;
  slug?: string;
}

export const journey: Stage[] = [
  {
    year: '2014',
    title: 'SchanNetwork',
    role: { pt: 'Fundador e desenvolvedor', en: 'Founder and developer' },
    text: {
      pt: 'Um servidor de Minecraft no PC de casa virou minha primeira faculdade: decompilar plugins, ler código dos outros, integrar APIs públicas e versionar tudo com Git.',
      en: 'A Minecraft server on my home PC became my first college: decompiling plugins, reading other people’s code, integrating public APIs and versioning everything with Git.',
    },
    slug: 'schannetwork',
  },
  {
    year: '2019',
    title: 'SaintMC',
    role: { pt: 'Desenvolvedor líder', en: 'Lead developer' },
    text: {
      pt: 'Rede competitiva com mais de 320 jogadores simultâneos, cache em camadas com Redis, anticheat próprio e tudo rodando em máquina dedicada administrada na mão.',
      en: 'A competitive network with more than 320 concurrent players, layered caching with Redis, a custom anticheat and everything running on a hand managed dedicated machine.',
    },
    slug: 'saintmc',
  },
  {
    year: '2022',
    title: 'DBServer',
    role: { pt: 'Engenheiro de Software', en: 'Software Engineer' },
    text: {
      pt: 'APIs em NestJS e Spring para clientes da indústria, CI/CD no Azure, integração com SAP e consultas SQL até 95% mais rápidas.',
      en: 'NestJS and Spring APIs for industrial clients, CI/CD on Azure, SAP integration and SQL queries up to 95% faster.',
    },
    slug: 'dbserver',
  },
  {
    year: '2023',
    title: 'Fiocruz',
    role: { pt: 'Cientista de Dados', en: 'Data Scientist' },
    text: {
      pt: 'Painel em Shiny sobre mortalidade no Rio de Janeiro para apoiar políticas públicas de saúde, com aprendizado não supervisionado.',
      en: 'A Shiny dashboard on mortality in Rio de Janeiro to support public health policy, using unsupervised learning.',
    },
    slug: 'fiocruz',
  },
  {
    year: '2025',
    title: { pt: 'Ciência da Computação', en: 'Computer Science' },
    role: 'UFRRJ',
    text: {
      pt: 'Bacharelado concluído em dezembro, seguido da pós em Ciência de Dados no Instituto Líbano.',
      en: 'Bachelor’s degree completed in December, followed by a graduate program in Data Science at Instituto Líbano.',
    },
  },
  {
    year: '2025',
    title: 'Netbr by SEK',
    role: { pt: 'Analista de Identidade e Acesso', en: 'Identity and Access Analyst' },
    text: {
      pt: 'Fluxos de CIAM em Azure e OpenShift, extensões em Java e integrações OAuth2 e OIDC, até a ida para a Great.',
      en: 'CIAM flows on Azure and OpenShift, Java extensions and OAuth2 and OIDC integrations, until I moved to Great.',
    },
    slug: 'netbr',
  },
];

interface Scraper {
  group: 'auctions' | 'government' | 'market';
  name: Text;
  detail: Text;
  slug: string | null;
}

export const scrapers: Scraper[] = [
  {
    group: 'auctions',
    name: { pt: 'Leilão de veículos no Brasil', en: 'Vehicle auctions in Brazil' },
    detail: { pt: 'Copart, Superbid e mais 8 fontes', en: 'Copart, Superbid and 8 more sources' },
    slug: 'brazil-vehicle-auctions-scraper',
  },
  {
    group: 'auctions',
    name: { pt: 'Leilão de veículos no México', en: 'Vehicle auctions in Mexico' },
    detail: { pt: 'Lotes com VIN e valor de mercado', en: 'Lots with VIN and market value' },
    slug: 'mexico-vehicle-auctions-scraper',
  },
  {
    group: 'auctions',
    name: { pt: 'Leilão de veículos na América Latina', en: 'Vehicle auctions in Latin America' },
    detail: { pt: 'Chile, Colômbia e Argentina', en: 'Chile, Colombia and Argentina' },
    slug: 'latam-vehicle-auctions-scraper',
  },
  {
    group: 'auctions',
    name: { pt: 'Imóveis da Caixa em leilão', en: 'Caixa real estate auctions' },
    detail: { pt: 'Desconto, ocupação, FGTS e financiamento', en: 'Discount, occupancy, FGTS and financing' },
    slug: 'brazil-real-estate-auctions',
  },
  {
    group: 'auctions',
    name: { pt: 'Leilão judicial de imóveis', en: 'Judicial property auctions' },
    detail: { pt: 'Praças, avaliação, processo e dívidas', en: 'Rounds, appraisal, lawsuit and debts' },
    slug: 'brazil-judicial-property-auctions',
  },
  {
    group: 'government',
    name: { pt: 'Licitações do PNCP', en: 'PNCP public tenders' },
    detail: { pt: 'Com monitor para alertas diários', en: 'With a monitor for daily alerts' },
    slug: 'brazil-public-tenders',
  },
  {
    group: 'government',
    name: { pt: 'Diários Oficiais', en: 'Official gazettes' },
    detail: { pt: 'DOU, estados e cerca de 380 municípios', en: 'DOU, states and about 380 cities' },
    slug: 'brazil-official-gazettes',
  },
  {
    group: 'government',
    name: { pt: 'Empresas por CNPJ', en: 'Companies by CNPJ' },
    detail: { pt: 'Empresas novas e leads B2B', en: 'New companies and B2B leads' },
    slug: null,
  },
  {
    group: 'market',
    name: { pt: 'Imóveis para alugar e comprar', en: 'Real estate for rent and sale' },
    detail: { pt: 'QuintoAndar, OLX e mais 2 portais', en: 'QuintoAndar, OLX and 2 more portals' },
    slug: 'brazil-real-estate-scraper',
  },
  {
    group: 'market',
    name: { pt: 'Imóveis em Portugal', en: 'Real estate in Portugal' },
    detail: { pt: 'Idealista, Imovirtual e mais 3 portais', en: 'Idealista, Imovirtual and 3 more portals' },
    slug: null,
  },
  {
    group: 'market',
    name: { pt: 'Carros usados com FIPE', en: 'Used cars with FIPE prices' },
    detail: { pt: 'Webmotors, Mobiauto, OLX e Kavak', en: 'Webmotors, Mobiauto, OLX and Kavak' },
    slug: 'brazil-used-cars-scraper',
  },
  {
    group: 'market',
    name: 'Reclame Aqui',
    detail: { pt: 'Reputação e reclamações por empresa', en: 'Reputation and complaints by company' },
    slug: 'reclame-aqui-scraper',
  },
];

export const skills: { area: Text; items: Text[] }[] = [
  { area: { pt: 'Linguagens', en: 'Programming languages' }, items: ['TypeScript', 'JavaScript', 'Java', 'Python', 'SQL', 'C#', 'Go', 'R'] },
  { area: 'Front-end', items: ['React', 'Next.js', 'TanStack Start', 'Astro', 'Tailwind CSS', 'SCSS', 'React Hook Form'] },
  { area: 'Back-end', items: ['Node.js', 'NestJS', 'Spring Boot', '.NET', 'Hono', 'REST', 'SOAP', 'OpenAPI', 'Kysely', 'Zod'] },
  {
    area: { pt: 'Integrações', en: 'Integrations' },
    items: ['SAP ERP', 'SAP MII', 'Pix', 'Pix Automático', 'Boleto', 'Webhooks', 'EPP'],
  },
  {
    area: { pt: 'Cloud e DevOps', en: 'Cloud and DevOps' },
    items: ['Cloudflare Workers', 'Durable Objects', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'k3s', 'OpenShift', 'CI/CD', 'GitHub Actions', 'Linux', 'Grafana', 'OpenTelemetry'],
  },
  {
    area: { pt: 'Dados e mensageria', en: 'Data and messaging' },
    items: ['PostgreSQL', 'SQL Server', 'MongoDB', 'Redis', 'D1', 'DuckDB', 'Pub/Sub', { pt: 'Filas', en: 'Queues' }],
  },
  {
    area: { pt: 'Segurança e IAM', en: 'Security and IAM' },
    items: ['OAuth2', 'OIDC', 'SAML', 'JWT', '2FA', 'Keycloak', 'Ping Identity', 'CIAM', 'OWASP'],
  },
  {
    area: { pt: 'IA e ciência de dados', en: 'AI and data science' },
    items: ['LLMs', 'RAG', { pt: 'Agentes', en: 'Agents' }, { pt: 'Servidores MCP', en: 'MCP servers' }, 'Evals', 'Pandas', 'Scikit-learn', 'R Shiny', { pt: 'Clusterização', en: 'Clustering' }],
  },
];

export const languages: { name: Text; level: Text }[] = [
  { name: { pt: 'Português', en: 'Portuguese' }, level: { pt: 'Nativo', en: 'Native' } },
  { name: { pt: 'Inglês', en: 'English' }, level: { pt: 'Avançado', en: 'Advanced' } },
  { name: { pt: 'Espanhol', en: 'Spanish' }, level: { pt: 'Iniciante', en: 'Beginner' } },
];

export const featuredStoryIds = [
  'araute/idempotency-three-layers',
  'great-softwares/collab-sqlite-write-cost',
  'salte/model-never-writes-numbers',
  'great-softwares/mcp-write-confirmation',
  'araute/nfse-lost-response',
  'saintmc/redis-pipeline-pool',
];
