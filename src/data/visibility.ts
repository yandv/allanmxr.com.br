export const isVisible = ({ data }: { data: { draft: boolean } }) => import.meta.env.DEV || !data.draft;
