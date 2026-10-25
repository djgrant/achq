// Must default-export a component. The mark is the same satellite as the favicon.
export default function Logo() {
  return (
    <div className="flex items-center gap-1.5">
      <svg viewBox="0 0 100 100" className="h-5 w-5" aria-hidden="true">
        <text y=".9em" fontSize="90">
          📡
        </text>
      </svg>
      <span className="text-xl font-black">achq</span>
    </div>
  );
}
