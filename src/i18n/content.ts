import { getCollection } from 'astro:content';
import { isVisible } from '../data/visibility';
import type { Locale } from './ui';

export const collectionsOf = {
  pt: { cases: 'cases', stories: 'stories' },
  en: { cases: 'casesEn', stories: 'storiesEn' },
} satisfies Record<Locale, { cases: 'cases' | 'casesEn'; stories: 'stories' | 'storiesEn' }>;

const visibleStories = async (locale: Locale) => {
  const projectIds = new Set((await getCollection(collectionsOf[locale].cases, isVisible)).map((entry) => entry.id));
  return (await getCollection(collectionsOf[locale].stories, isVisible)).filter((story) => projectIds.has(story.data.project.id));
};

export const getCasePaths = async (locale: Locale) => {
  const cases = (await getCollection(collectionsOf[locale].cases, isVisible)).toSorted((a, b) => a.data.order - b.data.order);
  const stories = await visibleStories(locale);
  const storiesOf = (projectId: string) =>
    stories.filter((story) => story.data.project.id === projectId).toSorted((a, b) => a.data.order - b.data.order);
  return cases.map((entry, index) => {
    const next = cases[(index + 1) % cases.length];
    return {
      params: { slug: entry.id },
      props: {
        entry,
        previous: cases[(index - 1 + cases.length) % cases.length],
        next,
        nextStoryCount: storiesOf(next.id).length,
        stories: storiesOf(entry.id),
      },
    };
  });
};

export const getStoryPaths = async (locale: Locale) => {
  const stories = await visibleStories(locale);
  return stories.map((story) => {
    const [project, slug] = story.id.split('/');
    const siblings = stories
      .filter((sibling) => sibling.data.project.id === story.data.project.id)
      .toSorted((a, b) => a.data.order - b.data.order);
    const position = siblings.findIndex((sibling) => sibling.id === story.id);
    return {
      params: { project, story: slug },
      props: {
        story,
        position: position + 1,
        total: siblings.length,
        previous: siblings[(position - 1 + siblings.length) % siblings.length],
        next: siblings[(position + 1) % siblings.length],
      },
    };
  });
};
