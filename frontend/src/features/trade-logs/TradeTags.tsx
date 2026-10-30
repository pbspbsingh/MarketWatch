import { memo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import type { TradeLogTag } from "../../api/tradeLogs";
import { deleteTradeLogTagMutationOptions, saveTradeLogTagMutationOptions } from "./tradeLogQuery";
import { errorMessage } from "./format";

export const TradeTags = memo(function TradeTags({ tags }: { tags: TradeLogTag[] }) {
  const [editing, setEditing] = useState<{ tag: TradeLogTag | null; name: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState<TradeLogTag | null>(null);
  const client = useQueryClient();
  const saveMutation = useMutation(saveTradeLogTagMutationOptions(client));
  const deleteMutation = useMutation(deleteTradeLogTagMutationOptions(client));
  const busy = saveMutation.isPending || deleteMutation.isPending;
  const [error, setError] = useState("");
  const save = async () => {
    if (!editing || busy) return;
    setError("");
    try { await saveMutation.mutateAsync(editing); setEditing(null); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setError("");
    try { await deleteMutation.mutateAsync(deleting); setDeleting(null); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="tl-tags">
    <div className="tl-section-heading"><div><h2>Your tag library</h2><p className="tl-caption">One flat library for trades and executions. Use names such as Entry:Good, EntryType:Breakout, Sale:Early, or Stop:Ignored.</p></div><Button variant="contained" size="small" onClick={() => { setError(""); setEditing({ tag: null, name: "", description: "" }); }}>Create tag</Button></div>
    <TableContainer><Table size="small" aria-label="Tag library"><TableHead><TableRow><TableCell>Tag name</TableCell><TableCell>Description</TableCell><TableCell align="right">Trade assignments</TableCell><TableCell align="right">Execution assignments</TableCell><TableCell align="right">Manage</TableCell></TableRow></TableHead>
      <TableBody>{tags.map(tag => <TableRow key={tag.id} hover><TableCell><strong>{tag.name}</strong></TableCell><TableCell><Tooltip title={tag.description ? <span className="tl-tag-description-tooltip">{tag.description}</span> : ""}><span className="tl-tag-description" tabIndex={tag.description ? 0 : undefined}>{tag.description || "—"}</span></Tooltip></TableCell><TableCell align="right">{tag.trade_count}</TableCell><TableCell align="right">{tag.execution_count}</TableCell><TableCell align="right"><Tooltip title="Edit tag"><IconButton size="small" aria-label={`Edit ${tag.name}`} onClick={() => { setError(""); setEditing({ tag, name: tag.name, description: tag.description ?? "" }); }}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip><Tooltip title="Delete tag"><IconButton size="small" aria-label={`Delete ${tag.name}`} onClick={() => { setError(""); setDeleting(tag); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip></TableCell></TableRow>)}</TableBody>
    </Table></TableContainer>
    {!tags.length && <div className="tl-empty-small">Create your first tag to start finding patterns in your decisions.</div>}
    <p className="tl-caption">Assignment counts cover your entire journal. Tag names and descriptions belong to the shared library.</p>
    <Dialog open={editing !== null} onClose={() => { if (!busy) setEditing(null); }} fullWidth maxWidth="xs"><DialogTitle>{editing?.tag ? "Edit tag" : "Create tag"}</DialogTitle><DialogContent>{error && <Alert severity="error">{error}</Alert>}<TextField autoFocus fullWidth margin="dense" label="Tag name" value={editing?.name ?? ""} disabled={busy} onChange={e => setEditing(current => current && { ...current, name: e.target.value })} slotProps={{ htmlInput: { maxLength: 100 } }} onKeyDown={e => { if (e.key === "Enter" && editing?.name.trim()) void save(); }} /><TextField fullWidth multiline minRows={3} maxRows={8} margin="dense" label="Description (optional)" helperText="Describe when to use this tag." value={editing?.description ?? ""} disabled={busy} onChange={e => setEditing(current => current && { ...current, description: e.target.value })} slotProps={{ htmlInput: { maxLength: 2000 } }} /></DialogContent><DialogActions><Button disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button variant="contained" disabled={busy || !editing?.name.trim()} onClick={() => void save()}>Save tag</Button></DialogActions></Dialog>
    <Dialog open={deleting !== null} onClose={() => { if (!busy) setDeleting(null); }} fullWidth maxWidth="xs"><DialogTitle>Delete {deleting?.name}?</DialogTitle><DialogContent>{error && <Alert severity="error">{error}</Alert>}This removes the tag from all trades and executions. Trades and executions are preserved. Open drafts using it will need to be reloaded or updated.</DialogContent><DialogActions><Button disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button color="error" disabled={busy} onClick={() => void remove()}>Delete tag</Button></DialogActions></Dialog>
  </div>;
});
