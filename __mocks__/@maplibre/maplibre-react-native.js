const React = require('react');
const { View } = require('react-native');

const MockComponent = (name) =>
  React.forwardRef((props, _ref) =>
    React.createElement(View, { ...props, testID: props.testID || name }, props.children)
  );

module.exports = {
  __esModule: true,
  default: {
    Map: MockComponent('MapLibreMap'),
    Camera: MockComponent('MapLibreCamera'),
    Marker: MockComponent('MapLibreMarker'),
    UserLocation: MockComponent('MapLibreUserLocation'),
  },
  Map: MockComponent('MapLibreMap'),
  Camera: MockComponent('MapLibreCamera'),
  Marker: MockComponent('MapLibreMarker'),
  UserLocation: MockComponent('MapLibreUserLocation'),
  LocationManager: {
    setMinDisplacement: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListener: jest.fn(),
    getCurrentPosition: jest.fn(() => Promise.resolve(null)),
  },
  OfflineManager: {
    getPacks: jest.fn(() => Promise.resolve([])),
    createPack: jest.fn(() => Promise.resolve()),
    deletePack: jest.fn(() => Promise.resolve()),
  },
};

