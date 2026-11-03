import { SqlWorkbench } from "./SqlWorkbench";
import { usePreferences } from "../../app/preferences";
import { useWindowTheme } from "../../app/useWindowTheme";
import "../../styles/index.css";

export default function SqlWorkbenchWindow({ id }: { id: string }) {
  const { activeTheme } = usePreferences();
  useWindowTheme(activeTheme === "dark");
  return <main className="sql-workbench-window"><SqlWorkbench workbenchId={id} separate /></main>;
}
