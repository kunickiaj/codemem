import { render } from "preact";
import { Gallery } from "./gallery";
import "./gallery.css";

const mount = document.getElementById("gallery-root");
if (!mount) throw new Error("Gallery mount is missing");
render(<Gallery />, mount);
