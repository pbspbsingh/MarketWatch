import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";

type IndustryMembershipRefreshDialogProps = {
  industryCount: number;
  onCancel: () => void;
  onConfirm: () => void;
};

export function IndustryMembershipRefreshDialog({
  industryCount,
  onCancel,
  onConfirm,
}: IndustryMembershipRefreshDialogProps) {
  return (
    <Dialog open onClose={onCancel} aria-labelledby="industry-membership-refresh-title">
      <DialogTitle id="industry-membership-refresh-title">Refresh ticker memberships?</DialogTitle>
      <DialogContent>
        <Typography>
          This will query Finviz for {industryCount} selected {industryCount === 1
            ? "industry"
            : "industries"} and replace their existing ticker mappings. Theme assignments will not
          be changed.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={onConfirm}>Refresh tickers</Button>
      </DialogActions>
    </Dialog>
  );
}
