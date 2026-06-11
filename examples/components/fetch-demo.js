export function filteredPosts(state) {
  const posts = state.allPosts || [];
  const term = (state.searchTerm || "").toLowerCase();
  const userId = state.selectedUserId ? Number(state.selectedUserId) : null;

  return posts.filter((p) => {
    if (userId && p.userId !== userId) {
      return false;
    }
    if (term && !p.title.toLowerCase().includes(term) && !p.body.toLowerCase().includes(term)) {
      return false;
    }
    return true;
  });
}

export function paginatedPosts(state) {
  const filtered = state.filteredPosts || [];
  const page = state.currentPage || 1;
  const perPage = state.perPage || 10;
  const start = (page - 1) * perPage;
  return filtered.slice(start, start + perPage);
}

export function statsText(state) {
  const total = (state.allPosts || []).length;
  const filtered = (state.filteredPosts || []).length;
  if (filtered === total) {
    return `${total} posts`;
  }
  return `${filtered} of ${total} posts`;
}
