export function GalaxyTabPresetIcon() {
  return (
    <svg
      className="preset-device-icon"
      viewBox="0 0 44 52"
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <rect x="5" y="2" width="30.2" height="48" rx="3.1" fill="#eee8de" stroke="#9b856d" />
      <rect x="6.2" y="3.2" width="27.8" height="45.6" rx="2.2" fill="#887a69" />
      <rect x="6.9" y="4.9" width="26.4" height="42.24" rx="1.4" fill="#fdfbf6" />
      <text
        x="20.1"
        y="28.5"
        fill="#79583e"
        fontFamily="system-ui, sans-serif"
        fontSize="6.5"
        fontWeight="600"
        textAnchor="middle"
      >
        120Hz
      </text>
      <circle cx="34.5" cy="26" r=".45" fill="#5d5348" />
      <path d="M12 2h4m19.3 8v4" stroke="#9b856d" strokeWidth=".7" strokeLinecap="round" />
      <path
        d="M38.5 5.5a1.1 1.1 0 0 1 2.2 0v37.7L39.6 47l-1.1-3.8Z"
        fill="#887a69"
        stroke="#6c5f50"
        strokeWidth=".6"
        strokeLinejoin="round"
      />
      <path d="M39 13h1.2m-.6 30.3V46" stroke="#eee8de" strokeWidth=".6" strokeLinecap="round" />
    </svg>
  );
}

function IPadPresetIcon({ mini = false }: { mini?: boolean }) {
  const x = mini ? 8 : 5;
  const y = mini ? 5 : 2;
  const width = mini ? 28 : 34;
  const height = mini ? 42 : 48;
  const screenWidth = width - 4.6;
  const screenHeight = screenWidth * (mini ? 2316 / 1512 : 2360 / 1640);
  return (
    <svg
      className="preset-device-icon"
      viewBox="0 0 44 52"
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <rect x={x} y={y} width={width} height={height} rx="3.4" fill="#eee8de" stroke="#9b856d" />
      <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} rx="2.6" fill="#887a69" />
      <rect
        x={x + 2.3}
        y={y + (height - screenHeight) / 2}
        width={screenWidth}
        height={screenHeight}
        rx="1.6"
        fill="#fdfbf6"
      />
      <circle cx={x + width - 1.5} cy="26" r=".45" fill="#eee8de" />
      <path
        d={`M${x + width * 0.61} ${y}h4M${x + width * 0.4} ${y}h2`}
        stroke="#9b856d"
        strokeWidth=".7"
        strokeLinecap="round"
      />
      <text
        x="22"
        y="28.5"
        fill="#79583e"
        fontFamily="system-ui, sans-serif"
        fontSize={mini ? 6.5 : 7.5}
        fontWeight="600"
        textAnchor="middle"
      >
        60Hz
      </text>
    </svg>
  );
}

export function IPadMiniPresetIcon() {
  return <IPadPresetIcon mini />;
}

export function IPadAirPresetIcon() {
  return <IPadPresetIcon />;
}
