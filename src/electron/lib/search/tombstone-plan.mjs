// Plan which indexed notes to remove after a sync walk: a note is tombstoned
// only when its own section was walked successfully in this sync and the note
// was not seen — so a skipped (failed) section never loses its index entries.
// Port of the tombstone pass in SearchService.SyncAsync (dotnetonenoteindexer).

export default function tombstonePlan({ indexed, seen, walkedSections }) {
    const remove = []
    for (const note of indexed) {
        if (walkedSections.has(note.sectionId) && !seen.has(note.id)) {
            remove.push(note.id)
        }
    }
    return remove
}
