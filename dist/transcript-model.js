// Branch-navigation adapter adapted from OpenClaw v2026.9.6, MIT.
// No private SDK imports. Parity-tested against the installed 2026.9.6 implementation.
const isRecord=v=>v!==null && typeof v==="object" && !Array.isArray(v);
const readNonBlankString=v=>typeof v==="string" && v.trim()?v.trim():undefined;
function isCanonicalSessionEntryType(value) {
	switch (value) {
		case "message":
		case "thinking_level_change":
		case "model_change":
		case "compaction":
		case "reset":
		case "branch_summary":
		case "custom":
		case "custom_message":
		case "label":
		case "session_info": return true;
		default: return false;
	}
}
function isCanonicalSessionTranscriptEntry(record) {
	return isRecord(record) && isCanonicalSessionEntryType(record.type);
}
function isSessionTranscriptSideAppendEntry(record) {
	return isCanonicalSessionTranscriptEntry(record) && record.appendMode === "side";
}
function isSessionTranscriptLeafControl(record) {
	return isRecord(record) && record.type === "leaf" && parseSessionTranscriptTreeEntry(record) !== void 0;
}
/**
* Parse one parent-linked transcript row.
*
* Leaf rows are navigation controls: they select targetId as the active leaf,
* and descendants that reference the marker continue through that same target.
*/
function parseSessionTranscriptTreeEntry(record) {
	if (!isRecord(record) || record.type === "session" || !Object.hasOwn(record, "parentId")) return;
	const id = readNonBlankString(record.id);
	const parentId = record.parentId === null ? null : readNonBlankString(record.parentId) ?? void 0;
	if (!id || parentId === void 0) return;
	if (record.type === "leaf") {
		const targetId = record.targetId === null ? null : readNonBlankString(record.targetId) ?? void 0;
		const appendParentId = record.appendParentId === void 0 ? targetId : record.appendParentId === null ? null : readNonBlankString(record.appendParentId) ?? void 0;
		const appendMode = record.appendMode === void 0 ? void 0 : record.appendMode === "side" ? "side" : null;
		return targetId === void 0 || appendParentId === void 0 || appendMode === null ? void 0 : {
			id,
			parentId: targetId,
			leafId: targetId,
			appendParentId,
			...appendMode ? { appendMode } : {}
		};
	}
	return {
		id,
		parentId,
		leafId: isCanonicalSessionTranscriptEntry(record) && record.appendMode !== "side" ? id : void 0,
		appendParentId: id,
		...record.appendMode === "side" ? { appendMode: record.appendMode } : {}
	};
}
function parseParentlessCanonicalEntry(record, parentId) {
	if (!isCanonicalSessionTranscriptEntry(record) || Object.hasOwn(record, "parentId")) return;
	const id = readNonBlankString(record.id);
	return id ? {
		id,
		parentId,
		leafId: record.appendMode === "side" ? void 0 : id,
		appendParentId: id,
		...record.appendMode === "side" ? { appendMode: record.appendMode } : {}
	} : void 0;
}
function resolveCanonicalParentId(parentId, byId) {
	let seen;
	let currentId = parentId;
	while (currentId !== null) {
		if (seen?.has(currentId)) return currentId;
		const parent = byId.get(currentId);
		if (!parent || !isSessionTranscriptLeafControl(parent.entry)) return currentId;
		(seen ??= /* @__PURE__ */ new Set()).add(currentId);
		currentId = parent.parentId;
	}
	return null;
}
function scanSessionTranscriptTree(entries) {
	const nodes = [];
	const byId = /* @__PURE__ */ new Map();
	return {
		nodes,
		byId,
		...scanSessionTranscriptNavigation(entries, {
			byId,
			addNode: (node) => nodes.push(node),
			resetDescendantIds: /* @__PURE__ */ new Set(),
			invalidLeafControlIds: /* @__PURE__ */ new Set()
		})
	};
}
/** Resolves the active branch leaf from the same transcript tree used by branch listing. */
function resolveSessionTranscriptActiveLeafEntryId(events) {
	return scanSessionTranscriptTree(events).leafId ?? void 0;
}
function scanSessionTranscriptNavigation(entries, storage) {
	const { byId, resetDescendantIds, invalidLeafControlIds } = storage;
	let leafId = null;
	let appendParentId = null;
	let hasLeafControl = false;
	let hasLeafUpdate = false;
	let hasExplicitLeafUpdate = false;
	let hasInvalidLeafControl = false;
	let latestResetId;
	let nextIndex = 0;
	for (const entry of entries) {
		const index = nextIndex++;
		let explicitTreeEntry = parseSessionTranscriptTreeEntry(entry);
		if (latestResetId && leafId !== null && explicitTreeEntry?.leafId !== void 0 && isSessionTranscriptLeafControl(entry) && (explicitTreeEntry.leafId === null || !resetDescendantIds.has(explicitTreeEntry.leafId))) explicitTreeEntry = {
			...explicitTreeEntry,
			parentId: leafId,
			leafId,
			appendParentId: leafId
		};
		const isKnownLeafReference = (id) => id === null || byId.has(id) && !invalidLeafControlIds.has(id);
		if (explicitTreeEntry?.leafId !== void 0 && isSessionTranscriptLeafControl(entry) && (!isKnownLeafReference(explicitTreeEntry.leafId) || !isKnownLeafReference(explicitTreeEntry.appendParentId)) && explicitTreeEntry) {
			hasInvalidLeafControl = true;
			invalidLeafControlIds.add(explicitTreeEntry.id);
			const rawParentId = entry.parentId;
			const node = {
				...explicitTreeEntry,
				parentId: rawParentId,
				leafId: void 0,
				appendParentId,
				entry,
				index
			};
			storage.addNode(node);
			byId.set(node.id, node);
			continue;
		}
		let treeEntry = explicitTreeEntry ?? parseParentlessCanonicalEntry(entry, leafId);
		if (treeEntry && isCanonicalSessionTranscriptEntry(entry)) {
			const canonicalParentIsStale = explicitTreeEntry && treeEntry.parentId !== null && !byId.has(treeEntry.parentId) && leafId !== null;
			const normalizedParentId = resolveCanonicalParentId(latestResetId !== void 0 && treeEntry.appendMode !== "side" && (treeEntry.parentId === null || !resetDescendantIds.has(treeEntry.parentId)) ? leafId : treeEntry.appendMode !== "side" && canonicalParentIsStale ? leafId : explicitTreeEntry && treeEntry.appendMode !== "side" && treeEntry.parentId === appendParentId && leafId !== appendParentId ? leafId : treeEntry.parentId, byId);
			if (normalizedParentId !== treeEntry.parentId) treeEntry = {
				...treeEntry,
				parentId: normalizedParentId
			};
		}
		if (!treeEntry) continue;
		const node = {
			...treeEntry,
			entry,
			index
		};
		storage.addNode(node);
		byId.set(node.id, node);
		if (isRecord(entry) && entry.type === "reset") {
			latestResetId = node.id;
			resetDescendantIds.clear();
			resetDescendantIds.add(node.id);
		} else if (latestResetId !== void 0 && node.parentId !== null && resetDescendantIds.has(node.parentId)) resetDescendantIds.add(node.id);
		appendParentId = node.appendParentId;
		if (node.leafId !== void 0) {
			leafId = node.leafId;
			hasLeafUpdate = true;
			if (explicitTreeEntry) hasExplicitLeafUpdate = true;
		}
		if (isSessionTranscriptLeafControl(entry)) hasLeafControl = true;
	}
	return {
		leafId,
		appendParentId,
		hasLeafControl,
		hasLeafUpdate,
		hasExplicitLeafUpdate,
		hasInvalidLeafControl
	};
}

export { scanSessionTranscriptTree, isCanonicalSessionTranscriptEntry };
export function activeBranch(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Transcript source is empty');
  const ids=new Set();
  for(const e of entries){
    if(!isRecord(e)) throw new Error('Transcript structure is incomplete; refusing export');
    if(isCanonicalSessionTranscriptEntry(e)||e.type==='leaf'){
      if(!readNonBlankString(e.id)||ids.has(e.id)) throw new Error('Transcript contains missing or duplicate entry IDs');
      ids.add(e.id);
      if(!Number.isFinite(Date.parse(e.timestamp)))throw new Error('Transcript entry timestamp is invalid');
    }
  }
  const tree=scanSessionTranscriptTree(entries);
  if(tree.hasInvalidLeafControl)throw new Error('Transcript has invalid navigation controls');
  const result=[]; const seen=new Set();let current=tree.leafId;
  while(current){
    if(seen.has(current))throw new Error('Transcript branch cycle');seen.add(current);
    const n=tree.byId.get(current);if(!n)throw new Error('Transcript branch ancestor unavailable');
    if(isCanonicalSessionTranscriptEntry(n.entry))result.push({...n.entry,parentId:n.parentId});
    current=n.parentId;
  }
  const branch=result.reverse();
  const newestReset=entries.findLast(e=>e.type==='reset');
  if(newestReset && !branch.some(e=>e.id===newestReset.id))throw new Error('Latest reset is not provable on active branch');
  return branch;
}

// Preserve the upstream MIT notice in dependency-free packed artifacts.
Object.defineProperty(scanSessionTranscriptTree, "license", { value: "MIT License\n\nCopyright (c) 2026 OpenClaw Foundation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\nThird-party notices for incorporated or adapted code are recorded in\nTHIRD_PARTY_NOTICES.md.\n" });
