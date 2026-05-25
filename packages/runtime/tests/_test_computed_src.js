export function total(/** @type {any} */ state) {
  return (state.items || []).length;
}

export function filteredPosts(/** @type {any} */ state) {
  const posts = state.allPosts || [];
  const term = (state.searchTerm || "").toLowerCase();
  return posts.filter((/** @type {any} */ p) => !term || p.title.toLowerCase().includes(term));
}

export function paginatedItems(/** @type {any} */ state) {
  const items = state.allItems || [];
  const page = state.currentPage || 1;
  const perPage = state.perPage || 5;
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
