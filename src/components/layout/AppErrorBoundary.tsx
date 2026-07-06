import React, { type ReactNode } from "react";

export class AppErrorBoundary extends React.Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#0b0b0d",
          color: "#e4e4e7",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ margin: 0 }}>Roblox Account Manager hit an unexpected error. Your accounts are safe.</p>
        <pre
          style={{
            maxHeight: "40vh",
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflow: "auto",
            maxWidth: 640,
            width: "100%",
            boxSizing: "border-box",
            whiteSpace: "pre-wrap",
          }}
        >
          {String(error.stack || error.message)}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "1px solid #3f3f46",
            background: "#27272a",
            color: "#e4e4e7",
            cursor: "pointer",
          }}
        >
          Reload App
        </button>
      </div>
    );
  }
}
