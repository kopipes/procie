function isSubsequence(query, candidate) {
  let pointer = 0;

  for (const char of candidate) {
    if (char === query[pointer]) {
      pointer += 1;
    }

    if (pointer === query.length) {
      return true;
    }
  }

  return false;
}

export function matchesPerson(query, name) {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return (
    normalizedName.includes(normalizedQuery) ||
    isSubsequence(normalizedQuery, normalizedName)
  );
}

export function filterPeople(people, query) {
  return people.filter((person) => matchesPerson(query, person.name));
}
