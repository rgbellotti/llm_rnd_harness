# Introduction to 3D
<seo>
Introduction to creating 3D environments in Godot 4.2. Descriptions on the 3D editor GUI and the different menu components and screen layout. Learn the tools, viewports, camera, 3D asset management, 3D workspace development, keyboard shortcuts, Nodes.
</seo>

## 3D Workspace
1. Editing 3D scenes is done in the 3D workspace.
2. The tabs below the workspace selector are used to change between currently opened scenes or create a new one using the '+' button.
3. Below the scene selector is the main toolbar, and below the main toolbar is the 3D viewport.

### Main toolbar
1. Hover over the toolbar buttons with the mouse for a brief explanation.
2. Some buttons have additional functionality if another keypress is performed.

#### Transform Mode
1. Keyboard: `Q`.
2. Enables move and rotation mode for the selected nodes.

#### Move Mode
1. Keyboard: `W`.
2. Enables move (translate) mode for the selected nodes.

#### Rotate Mode
1. Keyboard: `E`.
2. Enables rotation mode for the selected nodes.

#### Scale Mode
1. Keyboard: `R`.
2. Enables scaling and displays scaling gizmos in the different axes for the selected nodes.

#### Select Mode
1. Keyboard: `Q`.
2. Allows selection of nodes in the viewport by left clicking on one.
3. Holding a left click and dragging a rectangle selects all nodes within the rectangle when the left click is released.
4. Holding `Shift` while selecting nodes adds them to the group selection.
5. Clicking on an already selected node while holding `Shift` will deselect the node.
6. You can use the gizmos to perform movement or rotation in Select Mode.

#### Show the list of selectable nodes at the clicked position
1. No assigned hotkey for "show selectable nodes".
2. This provides a list of selectable nodes at the clicked position as a context menu, if there is more than one node in the clicked area.

#### Lock
1. Keyboard: `Ctrl + L`
2. Locks the selected nodes, preventing selection and movement in the viewport.
3. When locked, pressing the button again will unlock the selected nodes, or by pressing `Ctrl + Shift + L`.
4. Locked nodes can only be selected in the scene tree.
5. They can easily be identified with a padlock next to their node names in the scene tree.
6. Clicking on the padlock in the scene tree also unlocks a locked node.

#### Group selected nodes
1. Keyboard: `Ctrl + G`
2. Allows selection of the root node if any of the children are selected.
3. Pressing `Ctrl + G` again will ungroup a selection of grouped nodes.
4. There is also an "ungroup" button available in the scene tree.

#### Ruler mode
1. Keyboard: `M`
2. When Ruler mode is enabled, you can click and drag to measure distance in the scene in meters.

#### Use Local Space
1. Keyboard: `T`
2. If "Use Local Space" is enabled, the gizmos of a node are drawn using the current node's rotation angle instead of the global viewport axes.

#### Use Snap
1. Keyboard: `Y`
2. If "Use Snap" is enabled, movement and rotation snap to grid.
3. Snapping can also be temporarily activated by pressing `Ctrl` while performing an action.

#### Use Trackball
1. Keyboard: `U`
2. If "Use Trackball" is enabled, dragging the center of a node (by clicking on the subtle ray disc highlight) will rotate the node like a physical trackball.

#### Preserve Children Transform
1. Keyboard: `P`
2. When "Preserve Children Transform" is enabled, transforming a node will preserve the global transform of its children.

#### Toggle preview sunlight
1. No assigned hotkey for "Toggle preview sunlight".
2. If no DirectionalLight3D exists in the scene, a preview of sunlight can be used as a light source.

#### Toggle preview environment
1. No assigned hotkey for "Toggle preview environment".
2. If no WorldEnvironment exists in the scene, a preview of the environment can be used as a placeholder.

#### Edit Sun and Environment Settings
1. Click on the ellipsis (...) for "Sun and Environment Settings"
2. Allows the user to configure the sunlight and environment settings.

#### Transform Menu
1. Transform menu has 3 options, Snap Object, Transform Dialog, and Snap Settings.
2. Option: Snap Object - snaps an object to a solid floor.
3. Option: Transform Dialogue - Opens a dialog to adjust transform parameters (translate, rotate, scale, and transform) manually.
4. Option: Snap Settings: Allows you to change transform, rotate snap (in degrees) and scale snap settings by percentage.

#### Viewport Menu
1. Controls the view options and enables additional viewports.
2. The viewport menu allows you to show/hide 1x1 meter grids for accurate placement.
3. The axis lines are 'Y (green) vertical axis', 'X (red) horizontal axis', 'Z (blue) depth(forward/backward) axis'.
4. Many types of gizmos can be toggled in the viewport menu.
5. The listed gizmos will have an open or closed "eye" icon to depict if they are visible or hidden. 
6. A half-open eye means the gizmo is visible through opaque surfaces too.
7. Clicking on "Settings" in this view menu opens a window to change the Vertical Field of View (VFOV) parameter (in degrees), Z-Near, and Z-Far values. 
8. Next to the "View" menu, additional buttons may be visible. A "Mesh" button appears when a MeshInstance3D is selected.  This provides some quick actions or tools to work on a specific node or selection.

##### View menu of Viewport
1. Below the Select tool, in the 3D viewport, clicking on the ellipsis (...) opens the "View Menu" for the viewport.
2. You can hide all gizmos in the editor's 3D view from this "View Menu" of the Viewport.
3. The "View Menu" also gives you options for toggling the Top/Bottom/Left/Right/Front/Rear views, switching between Perspective/Orthogonal View, Lock the view rotation, switch between Normal/Wireframe/Overdraw/Lighting/Unshaded and Advanced Display settings submenu available, "View Environment" toggle, "View Gizmos" toggle, "View Transform Gizmo" toggle, "View Grid" toggle, "View Information" toggle, "View Frame Time" toggle, "Half Resolution" toggle, "Audio Listener" toggle, "Enable Doppler" toggle, "Cinematic Preview" toggle, "Focus Origin" option, "Focus Selection" option, "Align Transform with View" option, and "Align Rotation with View" option.

##### Coordinate System
1. Godot uses the metric system for everything in 3D space, with 1 unit being equal to 1 meter. Physics and other areas are tuned to this scale.
2. Set your 3D modeling software to metric for best compatibility when importing into Godot.
3. Scaling models post import is possible, though not the recommended approach and can bring complications.
4. Godot uses the "right-handed" coordinate system.  This means that for most objects that need alignment (such as lights or cameras), the Z-axis is used as a "pointing towards" direction.
5. X-axis is side-to-side, Y-axis is up and down, Z-axis is front and back.

##### Space and Manipulation Gizmos
1. Manipulator gizmos can move, rotate, and scale objects in the 3D view.
2. Each axis has its own color: X-red, Y-Green, Z-Blue.
3. To "snap to grid" placement during rotation, moving, or scaling, press `Ctrl` while performing the action.
4. To center the view on the selected object, press `F`.
5. In the viewport, the arrows can be clicked and held to move the object on an axis.
6. The arcs can be clicked and held to rotate the object.
7. To lock one axis and move freely along the other two axes, the colored rectangles offer that option for each axis.
8. Scale mode can shrink or enlarge the object when moving the mouse.

##### Navigating the 3D Environment
1. The viewport navigation controls are similar to Blender 3D, and the "Editor Settings" menu allows the user to change to other modes such as Maya or Modo controls, using "Editor Settings -> Editors -> 3D".  Then, under `Navigation`, search for `Navigation Scheme`.
2. Left click will select nodes and gizmos on the screen.  Middle-mouse button will allow the user to orbit the camera around the center of what is on screen.
3. The top-right of the viewport is a manipulator gizmo that depicts the 3 XYZ axes, and you can left click it to drag orbit the view, or single click on one of the axis "poles" for an orthogonal view of the Top/Bottom/Left/Right/Front/Back view, corresponding to which axis tip the user clicks on. 
4. Holding down the right mouse button on the viewport or pressing `Shift + F` switches to "free-look" mode: where the conventional movement keys, `W` `A` `S` `D` are usable to fly the camera around in the environment, `E` to move up, `Q` to move down.  The mouse can also be used to look around. To disable "free-look" mode, release the right mouse button or press `Shift + F` again.
5. In "free-look" mode, you can temporarily increase the flying speed using `Shift` or decrease it using `Alt`.
6. To change and keep the speed modifier you can use the `mouse wheel up` and `mouse wheel down` to increase or decrease the speed.
7. In orthogonal mode, holding the right mouse button will pan the view instead. Using `Keypad 5` to toggle between perspective and orthogonal view.

##### Using Blender-style Transform Shortcuts
1. In Godot 4.2, you can enable Blender shortcuts for translating, rotating, and scaling nodes.
2. Set the Blender shortcuts by going to the Editor Settings "Shortcuts" tab, then in the Spatial Editor section bind `Begin Translate Transformation` to `G`, `Begin Rotate Transformation` to `R`, `Begin Scale Transformation` to `S`. Lastly, unbind `Scale Mode` so that its shortcut won't conflict with `Begin Scale Transformation`.
3. After pressing the shortcut key, use the mouse to manipulate the selected node with your operation.
4. You can constrain movement to a specific axis by specifying the axis as a letter, then the distance (if entering a value with the keyboard). `Y` for vertical axis, `X` for horizontal axis, `Z` for forward/back axis.
5. As an example, to move the selection upwards 2.5 units, enter the following keypresses in order: `'G' 'Y' '2' '.' '5' 'Enter'`. 

### Node3D node
1. Node3D is the base unit for everything 3D in Godot.
2. Node3D has a local transform (X,Y,Z), which is relative to the parent node if the parent node is also Node3D or inherits from Node3D.
3. This transform can be accessed as a 3x4 Transform3D (a representation of a transformation in 3D space) or as Vector3 members representing location, Euler rotation (X,Y,Z) and scale.

#### 3D Content
1. It's possible to import 3D models in Godot using external tools such as Blender, or to generate geometry using Godot's tooling.
2. Scenes from 3D modeling software can be imported entirely, including animation, skeletal rigs, blend shapes, or as simple resources.
3. To create custom geometry use the `ArrayMesh` resource, by using the `ArrayMesh.add_surface_from_arrays()` function.  A helper class is also available, `SurfaceTool` which provides a more straightforward API and helpers for indexing, generating normals, tangents, etc.
4. Generating custom geometries is meant for static geometry (models that won't be updated often), because creating vertex arrays and submitting them to the 3D API has a significant performance cost.

#### Immediate Geometry
1. If you need to generate simple geometry that will be updated often, Godot provides a special `ImmediateMesh` resource that can be used in a `MeshInstance3D` node.  This provides an OpenGL 1.x-style immediate-mode API to create points, lines, triangles, etc.

#### 2D in 3D
1. By using a fixed camera (orthogonal or perspective) that does not rotate, nodes such as Sprite3D and AnimatedSprite3D can be used to create 2D games that take advantage of mixing with 3D backgrounds, more realistic parallax, lighting/shadow effects, etc.

### Environment
1. The `WorldEnvironment` node allows changing the background color, mode (toggle skybox), and applying several types of built-in post-processing effects.  Environments can also be overridden in the Camera.

#### Preview Environment and Light
1. By default, any 3D scene that doesn't have a `WorldEnvironment` node, or a `DirectionalLight3D`, will have a preview turned on for what it's missing to light the scene.
2. The preview light and environment will only be visible in the scene while in the editor.
3. If you run the scene or export the project they will not affect the scene.
4. The preview light and environment can be toggled from the top menu by clicking their respective icons.
5. The ellipsis (...) dropdown menu next to the "preview light" and "preview environment" icons, can be used to adjust the properties of the preview environment and light if they are enabled.
6. The same preview sun and environment is used for every scene in the same project, so only make adjustments that would apply to all of the scenes you will need a preview light and environment for.

#### Cameras
1. Camera3D is required to be able to view the scene, in either orthogonal or perspective style cameras.
2. Cameras are associated with (and only display to) a parent or grandparent viewport.  Since the root of the scene tree is a viewport, cameras will display on it by default, but if sub-viewports (either as render target or picture-in-picture) are desired, they need their own children cameras to display.  In terms of hierarchy: { "Root": { "Camera": { "Viewport": { "Camera": {} }}}}
3. When dealing with multiple cameras, the following rules are enforced for each viewport: "Rule1" - if no cameras are present in the scene tree, the first one that enters it will become the active camera. Further cameras entering the scene will be ignored unless they are set as current. "Rule2" - If a camera has the "current" property set, it will be used regardless of any other camera in the scene.  If the property is set, it will become active, replacing the previous camera. "Rule3" - If an active camera leaves the scene tree, the first camera in the tree-order will take its place.

#### Lights
1. The background environment emits some ambient light which appears on surfaces.
2. Without any light sources in the scene, the scene will appear very dark unless the background environment is set very bright.
3. Most outdoor scenes have a directional light (sun or moon), while indoor scenes typically have several positional lights (lamps, torches, etc).
