import { useId, useState, type MouseEvent } from "react";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import PhotoCameraOutlinedIcon from "@mui/icons-material/PhotoCameraOutlined";
import {
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
} from "@mui/material";

export type ImageExportAction = "download" | "copy";

interface ImageExportMenuProps {
  disabled?: boolean;
  busy?: boolean;
  disabledReason?: string;
  onSelect: (action: ImageExportAction) => void;
}

export function ImageExportMenu({
  disabled = false,
  busy = false,
  disabledReason,
  onSelect,
}: ImageExportMenuProps) {
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const unavailable = disabled || busy;

  const select = (action: ImageExportAction) => {
    setAnchor(null);
    onSelect(action);
  };

  return (
    <>
      <Tooltip title={disabled ? disabledReason : "Export image"}>
        <span>
          <IconButton
            size="small"
            type="button"
            aria-label="Export image"
            aria-controls={anchor === null ? undefined : menuId}
            aria-haspopup="menu"
            aria-expanded={anchor === null ? undefined : "true"}
            disabled={unavailable}
            onClick={(event: MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}
          >
            <PhotoCameraOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
      >
        <MenuItem onClick={() => select("download")}>
          <ListItemIcon><DownloadOutlinedIcon fontSize="small" /></ListItemIcon>
          Download
        </MenuItem>
        <MenuItem onClick={() => select("copy")}>
          <ListItemIcon><ContentCopyOutlinedIcon fontSize="small" /></ListItemIcon>
          Copy to Clipboard
        </MenuItem>
      </Menu>
    </>
  );
}
