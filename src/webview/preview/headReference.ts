import * as THREE from 'three'

export function createHeadReference(): THREE.Group {
  const group = new THREE.Group(); group.name = 'presentation-head-reference'
  const geometry = new THREE.BoxGeometry(12.8, 12.8, 12.8), edges = new THREE.EdgesGeometry(geometry)
  geometry.dispose()
  const wire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x7a8795, transparent: true, opacity: 0.65 }))
  wire.name = 'head-size-reference'; wire.raycast = () => undefined; group.add(wire)
  return group
}
