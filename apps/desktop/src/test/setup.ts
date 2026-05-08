import "@testing-library/jest-dom";

// jsdom does not implement ResizeObserver
(window as Window & { ResizeObserver: unknown }).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
