import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const localized = z.union([z.string(), z.object({ pt: z.string(), en: z.string() })]);

const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const resumePosition = z.object({
  company: z.string(),
  title: z.string(),
  location: z.string(),
  start: yearMonth,
  end: yearMonth.optional(),
  sideProject: z.boolean().default(false),
  bullets: z.array(z.string()).min(1),
  order: z.number(),
});

const resumeProject = z.object({
  summary: z.string(),
  order: z.number(),
});

const caseCollection = (base: string) =>
  defineCollection({
    loader: glob({ pattern: '*.md', base }),
    schema: ({ image }) =>
      z.object({
        title: z.string(),
        role: z.string(),
        period: z.string(),
        summary: z.string(),
        order: z.number(),
        draft: z.boolean().default(false),
        stack: z.array(z.string()),
        links: z.array(z.object({ href: z.url(), label: z.string() })).default([]),
        cover: image().optional(),
        gallery: z.array(z.object({ src: image(), alt: z.string() })).default([]),
        videos: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
        resume: z
          .union([z.array(resumePosition), resumePosition.transform((position) => [position]), resumeProject])
          .optional(),
      }),
  });

const storyCollection = (base: string, projectCollection: 'cases' | 'casesEn') =>
  defineCollection({
    loader: glob({ pattern: '**/*.md', base }),
    schema: z.object({
      title: z.string(),
      summary: z.string(),
      project: reference(projectCollection),
      order: z.number(),
      draft: z.boolean().default(false),
      tags: z.array(z.string()).default([]),
    }),
  });

export const collections = {
  cases: caseCollection('./src/content/cases'),
  casesEn: caseCollection('./src/content/cases-en'),
  stories: storyCollection('./src/content/stories', 'cases'),
  storiesEn: storyCollection('./src/content/stories-en', 'casesEn'),
  education: defineCollection({
    loader: glob({ pattern: '*.yaml', base: './src/content/education' }),
    schema: z.object({
      degree: localized,
      institution: z.string(),
      location: localized.optional(),
      start: z.number().int(),
      end: z.number().int().optional(),
      thesis: z.object({ title: localized, topics: localized }).optional(),
      order: z.number(),
    }),
  }),
};
