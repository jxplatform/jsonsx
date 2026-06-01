export function total(state: any) {
  return (state.items || []).length;
}

export function filteredPosts(state: any) {
  const posts = state.allPosts || [];
  const term = (state.searchTerm || "").toLowerCase();
  return posts.filter((p: any) => !term || p.title.toLowerCase().includes(term));
}

export function paginatedItems(state: any) {
  const items = state.allItems || [];
  const page = state.currentPage || 1;
  const perPage = state.perPage || 5;
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
