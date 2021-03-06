defineSuite([
         'Scene/CompositePrimitive',
         '../Specs/createContext',
         '../Specs/destroyContext',
         '../Specs/sceneState',
         '../Specs/pick',
         'Core/Cartesian3',
         'Core/Cartographic3',
         'Core/Ellipsoid',
         'Core/Math',
         'Scene/Camera',
         'Scene/CentralBody',
         'Scene/LabelCollection',
         'Scene/HorizontalOrigin',
         'Scene/VerticalOrigin',
         'Scene/Polygon'
     ], function(
         CompositePrimitive,
         createContext,
         destroyContext,
         sceneState,
         pick,
         Cartesian3,
         Cartographic3,
         Ellipsoid,
         CesiumMath,
         Camera,
         CentralBody,
         LabelCollection,
         HorizontalOrigin,
         VerticalOrigin,
         Polygon) {
    "use strict";
    /*global document,describe,it,expect,beforeEach,afterEach*/

    var context;
    var primitives;
    var us;
    var camera;

    beforeEach(function() {
        context = createContext();
        primitives = new CompositePrimitive();

        camera = new Camera(context.getCanvas());
        camera.position = new Cartesian3(1.02, 0.0, 0.0);
        camera.up = Cartesian3.getUnitZ();
        camera.direction = camera.position.negate();
        camera.frustum.near = 0.01;
        camera.frustum.far = 10.0;
        camera.frustum.fovy = CesiumMath.toRadians(60.0);
        camera.frustum.aspectRatio = 1.0;

        us = context.getUniformState();
        us.setView(camera.getViewMatrix());
        us.setProjection(camera.frustum.getProjectionMatrix());
        us.setSunPosition(new Cartesian3(-2.0, 0.0, 0.0));
    });

    afterEach(function() {
        primitives = primitives && primitives.destroy();
        us = null;
        camera = camera && camera.destroy();

        destroyContext(context);
    });

    function createLabels() {
        var labels = new LabelCollection();
        labels.add({
            position : {
                x : -1.0,
                y : 0.0,
                z : 0.0
            },
            text : "x",
            horizontalOrigin : HorizontalOrigin.CENTER,
            verticalOrigin : VerticalOrigin.CENTER
        });
        return labels;
    }

    function createPolygon() {
        var ellipsoid = Ellipsoid.getUnitSphere();
        var polygon = new Polygon();
        polygon.ellipsoid = ellipsoid;
        polygon.granularity = CesiumMath.toRadians(20.0);
        polygon.setPositions([
                              ellipsoid.toCartesian(CesiumMath.cartographic3ToRadians(new Cartographic3(-50.0, -50.0, 0.0))),
                              ellipsoid.toCartesian(CesiumMath.cartographic3ToRadians(new Cartographic3(50.0, -50.0, 0.0))),
                              ellipsoid.toCartesian(CesiumMath.cartographic3ToRadians(new Cartographic3(50.0, 50.0, 0.0))),
                              ellipsoid.toCartesian(CesiumMath.cartographic3ToRadians(new Cartographic3(-50.0, 50.0, 0.0)))
                             ]);
        return polygon;
    }

    it("gets default show", function() {
        expect(primitives.show).toBeTruthy();
    });

    it("has zero primitives when constructed", function() {
        expect(primitives.getLength()).toEqual(0);
    });

    it("adds a primitive with add()", function() {
        primitives.add(createLabels());
        expect(primitives.getLength()).toEqual(1);
    });

    it("removes the first primitive", function() {
        var p0 = createLabels();
        var p1 = createLabels();

        primitives.add(p0);
        primitives.add(p1);

        expect(primitives.getLength()).toEqual(2);

        expect(primitives.remove(p0)).toBeTruthy();
        expect(primitives.getLength()).toEqual(1);
        expect(primitives.get(0)).toBe(p1);

        expect(primitives.remove(p1)).toBeTruthy();
        expect(primitives.getLength()).toEqual(0);
    });

    it("removes the last primitive", function() {
        var p0 = createLabels();
        var p1 = createLabels();

        primitives.add(p0);
        primitives.add(p1);

        expect(primitives.getLength()).toEqual(2);

        expect(primitives.remove(p1)).toBeTruthy();
        expect(primitives.getLength()).toEqual(1);
        expect(primitives.get(0)).toBe(p0);

        expect(primitives.remove(p0)).toBeTruthy();
        expect(primitives.getLength()).toEqual(0);
    });

    it("removes a primitive twice", function() {
        var p0 = createLabels();
        primitives.add(p0);

        expect(primitives.remove(p0)).toBeTruthy();
        expect(primitives.remove(p0)).toBeFalsy();
    });

    it("removes null", function() {
        expect(primitives.remove()).toBeFalsy();
    });

    it("removes all primitives", function() {
        primitives.add(createLabels());
        primitives.add(createLabels());
        primitives.add(createLabels());

        expect(primitives.getLength()).toEqual(3);

        primitives.removeAll();
        expect(primitives.getLength()).toEqual(0);
    });

    it("contains a primitive", function() {
        var labels = createLabels();
        primitives.add(labels);

        expect(primitives.contains(labels)).toBeTruthy();
    });

    it("doesn't contain a primitive", function() {
        var labels0 = createLabels();
        var labels1 = createLabels();
        primitives.add(labels0);

        expect(primitives.contains(labels1)).toBeFalsy();
    });

    it("doesn't contain undefined", function() {
        expect(primitives.contains()).toBeFalsy();
    });

    it("adds and removes a primitive in two composites", function() {
        var p = createLabels();

        primitives.add(p);
        primitives.destroyPrimitives = false;

        var otherPrimitives = new CompositePrimitive(context);
        otherPrimitives.add(p);
        otherPrimitives.destroyPrimitives = false;

        // In both composites
        expect(primitives.contains(p)).toBeTruthy();
        expect(otherPrimitives.contains(p)).toBeTruthy();

        // In one composite
        expect(primitives.remove(p)).toBeTruthy();
        expect(primitives.contains(p)).toBeFalsy();
        expect(otherPrimitives.contains(p)).toBeTruthy();

        // In neither composite
        expect(otherPrimitives.remove(p)).toBeTruthy();
        expect(primitives.contains(p)).toBeFalsy();
        expect(otherPrimitives.contains(p)).toBeFalsy();
        expect(primitives.remove(p)).toBeFalsy();
        expect(otherPrimitives.remove(p)).toBeFalsy();

        p.destroy();
        otherPrimitives.destroy();
    });

    it("doesn't remove from a second composite", function() {
        var p = createLabels();
        primitives.add(p);

        var otherPrimitives = new CompositePrimitive(context);

        expect(otherPrimitives.contains(p)).toBeFalsy();
        expect(otherPrimitives.remove(p)).toBeFalsy();
    });

    it("gets default destroyPrimitives", function() {
        expect(primitives.destroyPrimitives).toBeTruthy();
    });

    it("setting a central body", function() {
        var ellipsoid = Ellipsoid.getUnitSphere();
        var cb = new CentralBody(camera, ellipsoid);
        primitives.setCentralBody(cb);

        expect(primitives.getCentralBody()).toBe(cb);
    });

    it("renders a central body", function() {
        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        var cb = new CentralBody(camera, Ellipsoid.getUnitSphere());
        primitives.setCentralBody(cb);

        primitives.update(context, sceneState);
        primitives.render(context, us);
        expect(context.readPixels()).not.toEqualArray([0, 0, 0, 0]);
    });

    it("renders a primitive added with add()", function() {
        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        primitives.add(createLabels());
        primitives.update(context, sceneState);
        primitives.render(context, us);
        expect(context.readPixels()).not.toEqualArray([0, 0, 0, 0]);
    });

    it("doesn't render", function() {
        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        primitives.show = false;
        primitives.add(createLabels());
        primitives.update(context, sceneState);
        primitives.render(context, us);
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);
    });

    it("renders a primitive in more than one composite", function() {
        var otherPrimitives = new CompositePrimitive(context);

        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        var p = createLabels();
        primitives.add(p);
        otherPrimitives.add(p);
        otherPrimitives.destroyPrimitives = false;

        primitives.update(context, sceneState);
        primitives.render(context, us);
        expect(context.readPixels()).not.toEqualArray([0, 0, 0, 0]);

        // Render using other composite
        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        otherPrimitives.update(context, sceneState);
        otherPrimitives.render(context, us);
        expect(context.readPixels()).not.toEqualArray([0, 0, 0, 0]);

        otherPrimitives.destroy();
    });

    it("renders child composites", function() {
        context.clear();
        expect(context.readPixels()).toEqualArray([0, 0, 0, 0]);

        var children = new CompositePrimitive();
        children.add(createLabels());
        primitives.add(children);

        primitives.update(context, sceneState);
        primitives.render(context, us);
        expect(context.readPixels()).not.toEqualArray([0, 0, 0, 0]);
    });

    it("picks a primitive added with add()", function() {
        var labels = createLabels();
        var l = labels.get(0);

        primitives.add(labels);
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(l);
    });

    it("doesn't pick", function() {
        var labels = createLabels();

        primitives.show = false;
        primitives.add(labels);
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).not.toBeDefined();
    });

    it("picks child composites", function() {
        var labels = createLabels();
        var l = labels.get(0);

        var children = new CompositePrimitive();
        children.add(labels);
        primitives.add(children);

        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(l);
    });

    it("picks a primitive added with render order (0)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p1);
    });

    it("picks a primitive added with render order (1)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p1);
        primitives.add(p0);
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p0);
    });

    it("picks a primitive added with bringForward (0)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.bringForward(p1); // Already on top
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p1);
    });

    it("picks a primitive added with bringForward (1)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.bringForward(p0); // Moved to top
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p0);
    });

    it("picks a primitive added with bringToFront (0)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.bringToFront(p1); // Already on top
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p1);
    });

    it("picks a primitive added with bringToFront (1)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.bringToFront(p0); // Moved to top
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p0);
    });

    it("picks a primitive added with sendBackward (0)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.sendBackward(p1); // Moved back
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p0);
    });

    it("picks a primitive added with sendBackward (1)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.sendBackward(p0); // Already on bottom
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p1);
    });

    it("picks a primitive added with sendToBack (0)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.sendToBack(p1); // Moved back
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p0);
    });

    it("picks a primitive added with sendToBack (1)", function() {
        var p0 = createPolygon();
        var p1 = createPolygon();

        primitives.add(p0);
        primitives.add(p1);
        primitives.sendToBack(p0); // Already on bottom
        primitives.update(context, sceneState);

        var pickedObject = pick(context, primitives, 0, 0);
        expect(pickedObject).toEqual(p1);
    });

    it("is not destroyed when first constructed", function() {
        expect(primitives.isDestroyed()).toBeFalsy();
    });

    it("is destroyed after calling destroy()", function() {
        var p = new CompositePrimitive();
        p.destroy();
        expect(p.isDestroyed()).toBeTruthy();
    });

    it("destroys its primitives", function() {
        var labels = new LabelCollection(context);

        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives = primitives.destroy();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("destroys children", function() {
        var labels = new LabelCollection(context);

        var children = new CompositePrimitive();
        children.add(labels);

        primitives.add(children);
        expect(children.isDestroyed()).toBeFalsy();
        expect(labels.isDestroyed()).toBeFalsy();

        primitives = primitives.destroy();
        expect(children.isDestroyed()).toBeTruthy();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("destroys primitive on remove", function() {
        var labels = new LabelCollection(context);

        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives.remove(labels);
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("destroys primitive on removeAll", function() {
        var labels = new LabelCollection(context);

        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives.removeAll();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("destroys primitive on setCentralBody", function() {
        var cb = new CentralBody(camera, Ellipsoid.getUnitSphere());

        primitives.setCentralBody(cb);
        expect(cb.isDestroyed()).toBeFalsy();

        primitives.setCentralBody(null);
        expect(cb.isDestroyed()).toBeTruthy();
    });

    it("doesn't destroy its primitives", function() {
        var labels = new LabelCollection(context);

        primitives.destroyPrimitives = false;
        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives = primitives.destroy();
        expect(labels.isDestroyed()).toBeFalsy();

        labels.destroy();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("doesn't destroy primitive on remove", function() {
        var labels = new LabelCollection(context);

        primitives.destroyPrimitives = false;
        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives.remove(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        labels.destroy();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("doesn't destroy primitive on removeAll", function() {
        var labels = new LabelCollection(context);

        primitives.destroyPrimitives = false;
        primitives.add(labels);
        expect(labels.isDestroyed()).toBeFalsy();

        primitives.removeAll();
        expect(labels.isDestroyed()).toBeFalsy();

        labels.destroy();
        expect(labels.isDestroyed()).toBeTruthy();
    });

    it("doesn't destroy primitive on setCentralBody", function() {
        var cb = new CentralBody(camera, Ellipsoid.getUnitSphere());

        primitives.destroyPrimitives = false;
        primitives.setCentralBody(cb);
        expect(cb.isDestroyed()).toBeFalsy();

        primitives.setCentralBody(null);
        expect(cb.isDestroyed()).toBeFalsy();

        cb.destroy();
        expect(cb.isDestroyed()).toBeTruthy();
    });

    it("throws when add() without an primitive", function() {
        expect(function() {
            primitives.add();
        }).toThrow();
    });

    it("bringForward throws when primitive is not in composite", function() {
        var p = createLabels();

        expect(function() {
            primitives.bringForward(p);
        }).toThrow();
    });

    it("bringToFront throws when primitive is not in composite", function() {
        var p = createLabels();

        expect(function() {
            primitives.bringToFront(p);
        }).toThrow();
    });

    it("sendBackward throws when primitive is not in composite", function() {
        var p = createLabels();

        expect(function() {
            primitives.sendBackward(p);
        }).toThrow();
    });

    it("sendToBack throws when primitive is not in composite", function() {
        var p = createLabels();

        expect(function() {
            primitives.sendToBack(p);
        }).toThrow();
    });
});