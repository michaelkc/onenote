// Flatten the notebook hierarchy (notebooks → section groups (nested) →
// sections) into a flat list of sections annotated with notebook/section names
// for display context, depth-first. Port of SearchService.EnumerateSections /
// EnumerateGroupSections (dotnetonenoteindexer).

function displayName(entity, fallback) {
    return entity.displayName || entity.title || fallback || ''
}

export default function flattenSections(notebooks, notebookFilter) {
    const sections = []

    const pushGroup = (group, notebookName) => {
        for (const section of group.sections || []) {
            sections.push({
                id: section.id,
                sectionName: displayName(section),
                notebookName,
            })
        }
        for (const nested of group.sectionGroups || []) {
            pushGroup(nested, notebookName)
        }
    }

    for (const notebook of notebooks || []) {
        if (notebookFilter && !notebookFilter(notebook)) {
            continue
        }
        const notebookName = displayName(notebook)
        for (const section of notebook.sections || []) {
            sections.push({
                id: section.id,
                sectionName: displayName(section),
                notebookName,
            })
        }
        for (const group of notebook.sectionGroups || []) {
            pushGroup(group, notebookName)
        }
    }

    return sections
}
