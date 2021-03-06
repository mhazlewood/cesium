/*global define*/
define([
        '../Core/DeveloperError',
        '../Core/RuntimeError',
        '../Core/combine',
        '../Core/destroyObject',
        '../Core/splice',
        '../Core/Math',
        '../Core/Intersect',
        '../Core/Occluder',
        '../Core/Ellipsoid',
        '../Core/BoundingSphere',
        '../Core/Rectangle',
        '../Core/Cache',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Cartographic2',
        '../Core/Matrix3',
        '../Core/ComponentDatatype',
        '../Core/IndexDatatype',
        '../Core/MeshFilters',
        '../Core/PrimitiveType',
        '../Core/CubeMapEllipsoidTessellator',
        '../Core/ExtentTessellator',
        '../Core/PlaneTessellator',
        '../Core/JulianDate',
        '../Renderer/BufferUsage',
        '../Renderer/CullFace',
        '../Renderer/DepthFunction',
        '../Renderer/PixelFormat',
        '../Renderer/MipmapHint',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        './Projections',
        './Tile',
        './TileState',
        './SceneMode',
        './Texture2DPool',
        './ViewportQuad',
        '../Shaders/CentralBodyVS',
        '../Shaders/CentralBodyFS',
        '../Shaders/CentralBodyVSDepth',
        '../Shaders/CentralBodyFSDepth',
        '../Shaders/CentralBodyVSFilter',
        '../Shaders/CentralBodyFSFilter',
        '../Shaders/Ray',
        '../Shaders/ConstructiveSolidGeometry',
        '../Shaders/SkyAtmosphereFS',
        '../Shaders/SkyAtmosphereVS'
    ], function(
        DeveloperError,
        RuntimeError,
        combine,
        destroyObject,
        splice,
        CesiumMath,
        Intersect,
        Occluder,
        Ellipsoid,
        BoundingSphere,
        Rectangle,
        Cache,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Cartographic2,
        Matrix3,
        ComponentDatatype,
        IndexDatatype,
        MeshFilters,
        PrimitiveType,
        CubeMapEllipsoidTessellator,
        ExtentTessellator,
        PlaneTessellator,
        JulianDate,
        BufferUsage,
        CullFace,
        DepthFunction,
        PixelFormat,
        MipmapHint,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        Projections,
        Tile,
        TileState,
        SceneMode,
        Texture2DPool,
        ViewportQuad,
        CentralBodyVS,
        CentralBodyFS,
        CentralBodyVSDepth,
        CentralBodyFSDepth,
        CentralBodyVSFilter,
        CentralBodyFSFilter,
        ShadersRay,
        ShadersConstructiveSolidGeometry,
        SkyAtmosphereFS,
        SkyAtmosphereVS) {
    "use strict";
    /*global document,Image,Uint16Array*/

    function TileTextureCachePolicy(description) {
        var desc = description || {};

        if (!desc.fetchFunc || typeof desc.fetchFunc !== "function") {
            throw new DeveloperError("description.fetchFunc is a required function.", "description.fetchFunc");
        }

        this._limit = desc.limit || 128;
        this._count = 0;
        this._fetchFunc = desc.fetchFunc;
        this._removeFunc = (typeof desc.removeFunc === "function") ? desc.removeFunc : undefined;
    }

    TileTextureCachePolicy.prototype.hit = function(object) {
        var time = new JulianDate();
        var current = object.key;
        while (current) {
            current._lastHit = time;
            current = current.parent;
        }
        return object.value;
    };

    TileTextureCachePolicy.prototype.miss = function(name, key, object) {
        var property = {
            key : key,
            value : undefined
        };

        property.value = this._fetchFunc(key);
        var lruTime = new JulianDate();
        this.hit(property);

        if (this._count < this._limit) {
            ++this._count;
            object[name] = property;
            return property.value;
        }

        var element;
        var index = '';
        var keys = Object.keys(object);
        for ( var i = 0; i < keys.length; ++i) {
            element = object[keys[i]];
            if (element.key._lastHit.lessThan(lruTime) && element.key.zoom > 2) {
                lruTime = element.key._lastHit;
                index = keys[i];
            }
        }

        element = object[index];
        if (this._removeFunc) {
            this._removeFunc(element.key);
        }
        delete object[index];

        object[name] = property;
        return property.value;
    };

    var attributeIndices = {
        position3D : 0,
        textureCoordinates : 1,
        position2D : 2
    };

    /**
     * DOC_TBA
     *
     * @param {Camera} camera DOC_TBA
     * @param {Ellipsoid} [ellipsoid=WGS84 Ellipsoid] Determines the size and shape of the central body.
     *
     * @name CentralBody
     * @constructor
     *
     * @exception {DeveloperError} camera is required.
     */
    function CentralBody(camera, ellipsoid) {
        if (!camera) {
            throw new DeveloperError("camera is required.", "camera");
        }

        ellipsoid = ellipsoid || Ellipsoid.getWgs84();

        this._ellipsoid = ellipsoid;
        this._maxExtent = {
            north : CesiumMath.PI_OVER_TWO,
            south : -CesiumMath.PI_OVER_TWO,
            west : -CesiumMath.PI,
            east : CesiumMath.PI
        };
        this._camera = camera;
        this._rootTile = new Tile({
            extent : this._maxExtent,
            zoom : 0,
            ellipsoid : ellipsoid
        });

        this._renderQueue = [];
        this._imageQueue = [];
        this._textureQueue = [];
        this._reprojectQueue = [];

        this._texturePool = undefined;
        this._textureCache = undefined;
        this._textureCacheLimit = 512; // TODO: pick appropriate cache limit

        // TODO: pick appropriate throttle limits
        this._textureThrottleLimit = 10;
        this._reprojectThrottleLimit = 10;
        this._imageThrottleLimit = 15;

        this._prefetchLimit = 1;

        this._spWithoutAtmosphere = undefined;
        this._spGroundFromSpace = undefined;
        this._spGroundFromAtmosphere = undefined;
        this._sp = undefined; // Reference to without-atmosphere, ground-from-space, or ground-from-atmosphere
        this._rsColor = undefined;

        this._spSkyFromSpace = undefined;
        this._spSkyFromAtmosphere = undefined;
        this._vaSky = undefined; // Reference to sky-from-space or sky-from-atmosphere
        this._spSky = undefined;
        this._rsSky = undefined;

        this._spDepth = undefined;
        this._vaDepth = undefined;
        this._rsDepth = undefined;

        this._quadH = undefined;
        this._quadV = undefined;

        this._fb = undefined;

        this._textureLogo = undefined;
        this.logoOffsetX = this.logoOffsetY = 0;
        this._quadLogo = undefined;

        this._dayTileProvider = undefined;
        this._nightImageSource = undefined;
        this._specularImageSource = undefined;
        this._cloudsImageSource = undefined;
        this._bumpImageSource = undefined;
        this._nightTexture = undefined;
        this._specularTexture = undefined;
        this._cloudsTexture = undefined;
        this._bumpTexture = undefined;
        this._showDay = false;
        this._showNight = false;
        this._showClouds = false;
        this._showCloudShadows = false;
        this._showSpecular = false;
        this._showBumps = false;
        this._showTerminator = false;

        this.refineFunc = this.refine;
        this.pixelError3D = 5.0;
        this.pixelError2D = 2.0;

        this.show = true;
        this.showGroundAtmosphere = false;
        this.showSkyAtmosphere = false;

        this.dayTileProvider = undefined;
        this.nightImageSource = undefined;
        this.specularImageSource = undefined;
        this.cloudsImageSource = undefined;
        this.bumpImageSource = undefined;
        this.showDay = true;
        this.showNight = true;
        this.showClouds = true;
        this.showCloudShadows = true;
        this.showSpecular = true;
        this.showBumps = true;

        this.bumpMapNormalZ = 0.5;
        this.dayNightBlendDelta = 0.05;
        this.showTerminator = false;
        this.nightIntensity = 2.0;
        this.morphTime = 1.0;

        this._mode = SceneMode.SCENE3D;
        this._projection = undefined;

        this._fCameraHeight = undefined;
        this._fCameraHeight2 = undefined;
        this._outerRadius = ellipsoid.getRadii().multiplyWithScalar(1.025).getMaximumComponent();

        // TODO: Do we want to expose any of these atmosphere constants?
        var Kr = 0.0025;
        var Kr4PI = Kr * 4.0 * Math.PI;
        var Km = 0.0015;
        var Km4PI = Km * 4.0 * Math.PI;
        var ESun = 15.0;
        var g = -0.95;
        var innerRadius = ellipsoid.getRadii().getMaximumComponent();
        var rayleighScaleDepth = 0.25;
        var inverseWaveLength = {
            x : 1.0 / Math.pow(0.650, 4.0), // Red
            y : 1.0 / Math.pow(0.570, 4.0), // Green
            z : 1.0 / Math.pow(0.475, 4.0) // Blue
        };

        this._minGroundFromAtmosphereHeight = 6378500.0; // from experimentation / where shader fails due to precision errors
        this._startFadeGroundFromAtmosphere = this._minGroundFromAtmosphereHeight + 1000;

        var that = this;

        var atmosphereUniforms = {
            v3InvWavelength : function() {
                return inverseWaveLength;
            },
            fCameraHeight : function() {
                return that._fCameraHeight;
            },
            fCameraHeight2 : function() {
                return that._fCameraHeight2;
            },
            fOuterRadius : function() {
                return that._outerRadius;
            },
            fOuterRadius2 : function() {
                return that._outerRadius * that._outerRadius;
            },
            fInnerRadius : function() {
                return innerRadius;
            },
            fInnerRadius2 : function() {
                return innerRadius * innerRadius;
            },
            fKrESun : function() {
                return Kr * ESun;
            },
            fKmESun : function() {
                return Km * ESun;
            },
            fKr4PI : function() {
                return Kr4PI;
            },
            fKm4PI : function() {
                return Km4PI;
            },
            fScale : function() {
                return 1.0 / (that._outerRadius - innerRadius);
            },
            fScaleDepth : function() {
                return rayleighScaleDepth;
            },
            fScaleOverScaleDepth : function() {
                return (1.0 / (that._outerRadius - innerRadius)) / rayleighScaleDepth;
            },
            g : function() {
                return g;
            },
            g2 : function() {
                return g * g;
            },
            fMinGroundFromAtmosphereHeight : function() {
                return that._minGroundFromAtmosphereHeight;
            },
            fstartFadeGroundFromAtmosphere : function() {
                return that._startFadeGroundFromAtmosphere;
            }
        };

        var uniforms = {
            u_nightTexture : function() {
                return that._nightTexture;
            },
            u_cloudMap : function() {
                return that._cloudsTexture;
            },
            u_specularMap : function() {
                return that._specularTexture;
            },
            u_bumpMap : function() {
                return that._bumpTexture;
            },
            u_bumpMapResoltuion : function() {
                return {
                    x : 1.0 / that._bumpTexture.getWidth(),
                    y : 1.0 / that._bumpTexture.getHeight()
                };
            },
            u_bumpMapNormalZ : function() {
                return that.bumpMapNormalZ;
            },
            u_dayNightBlendDelta : function() {
                return that.dayNightBlendDelta;
            },
            u_nightIntensity : function() {
                return that.nightIntensity;
            },
            u_morphTime : function() {
                return that.morphTime;
            }
        };

        // PERFORMANCE_IDEA:  Only combine these if showing the atmosphere.  Maybe this is too much of a micro-optimization.
        // http://jsperf.com/object-property-access-propcount
        this._drawUniforms = combine(uniforms, atmosphereUniforms);
    }

    /**
     * DOC_TBA
     *
     * @memberof CentralBody
     *
     * @return {Ellipsoid} DOC_TBA
     */
    CentralBody.prototype.getEllipsoid = function() {
        return this._ellipsoid;
    };

    CentralBody._isModeTransition = function(oldMode, newMode) {
        // SCENE2D, COLUMBUS_VIEW, and MORPHING use the same rendering path, so a
        // transition only occurs when switching from/to SCENE3D
        return ((oldMode !== newMode) &&
                ((oldMode === SceneMode.SCENE3D) ||
                 (newMode === SceneMode.SCENE3D)));
    };

    CentralBody.prototype._syncMorphTime = function(mode) {
        switch (mode) {
        case SceneMode.SCENE3D:
            this.morphTime = 1.0;
            break;

        case SceneMode.SCENE2D:
        case SceneMode.COLUMBUS_VIEW:
            this.morphTime = 0.0;
            break;

        // MORPHING - don't change it
        }
    };

    CentralBody.prototype._prefetchImages = function() {
        var limit = Math.max(Math.min(this._prefetchLimit, this._dayTileProvider.zoomMax), this._dayTileProvider.zoomMin);
        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            if (tile.zoom < limit) {
                this._processTile(tile);
                stack = stack.concat(tile.getChildren());
            } else if (tile.zoom === limit) {
                this._processTile(tile);
            }
        }
    };

    CentralBody.prototype._createTextureCache = function(context) {
        if (this._dayTileProvider &&
            typeof this._dayTileProvider.tileWidth !== "undefined" &&
            typeof this._dayTileProvider.tileHeight !== "undefined") {
            this._texturePool = new Texture2DPool(this._dayTileProvider.tileWidth, this._dayTileProvider.tileHeight);
        } else {
            this._texturePool = undefined;
        }

        var pool = this._texturePool;

        var fetch = function(tile) {
            var texture;

            var width = parseInt(tile.image.width, 10);
            var height = parseInt(tile.image.height, 10);
            var usePool = pool && (width === pool.getWidth() && height === pool.getHeight());
            var inPool = false;

            if (usePool && pool.hasAvailable()) {
                texture = pool.getTexture();
                inPool = true;
            } else {
                texture = context.createTexture2D({
                    width : width,
                    height : height,
                    pixelFormat : PixelFormat.RGB
                });
            }

            if (usePool && !inPool) {
                pool.add(texture);
            }
            return texture;
        };

        var remove = function(tile) {
            var width = tile.texture.getWidth();
            var height = tile.texture.getHeight();
            var usePool = (width === pool.getWidth() && height === pool.getHeight());

            if (usePool) {
                pool.remove(tile.texture);
                tile.texture = undefined;
            } else {
                tile.texture = tile.texture && tile.texture.destroy();
            }

            tile._extentVA = tile._extentVA && tile._extentVA.destroy();
            tile.projection = undefined;
            tile.state = TileState.READY;
        };

        var policy = new TileTextureCachePolicy({
            fetchFunc : fetch,
            removeFunc : remove,
            limit : this._textureCacheLimit
        });
        this._textureCache = new Cache(policy);
    };

    CentralBody.prototype._fetchImage = function(tile) {
        var onload = function() {
            tile.state = TileState.IMAGE_LOADED;
        };
        var onerror = function() {
            tile.state = TileState.IMAGE_FAILED;
        };
        var oninvalid = function() {
            tile.state = TileState.IMAGE_INVALID;
        };
        return this._dayTileProvider.loadTileImage(tile, onload, onerror, oninvalid);
    };

    CentralBody.prototype._getTileBoundingSphere = function (tile, mode, projection) {
        var boundingVolume;
        if (mode === SceneMode.SCENE3D) {
            boundingVolume = tile.get3DBoundingSphere().clone();
        } else if (mode === SceneMode.COLUMBUS_VIEW){
            boundingVolume = tile.get2DBoundingSphere(projection).clone();
            boundingVolume.center = new Cartesian3(0.0, boundingVolume.center.x, boundingVolume.center.y);
        } else {
            var bv3D = tile.get3DBoundingSphere();
            var bv2D = tile.get2DBoundingSphere(projection);
            boundingVolume = new BoundingSphere(
                    bv2D.center.lerp(bv3D, this.morphTime),
                    Math.max(bv2D.radius, bv3D.radius));
        }
        return boundingVolume;
    };

    CentralBody.prototype._frustumCull = function(tile, mode, projection) {
        if (mode === SceneMode.SCENE2D) {
            var bRect = tile.get2DBoundingRectangle(projection);

            var frustum = this._camera.frustum;
            var position = this._camera.position;
            var x = position.x + frustum.left;
            var y = position.y + frustum.bottom;
            var w = position.x + frustum.right - x;
            var h = position.y + frustum.top - y;
            var fRect = new Rectangle(x, y, w, h);

            return !Rectangle.rectangleRectangleIntersect(bRect, fRect);
        }

        var boundingVolume = this._getTileBoundingSphere(tile, mode, projection);
        return this._camera.getVisibility(boundingVolume, BoundingSphere.planeSphereIntersect) === Intersect.OUTSIDE;
    };

    CentralBody.prototype._throttleImages = function() {
        var j = 0;
        for ( var i = 0; i < this._imageQueue.length && j < this._imageThrottleLimit; ++i) {
            var tile = this._imageQueue[i];

            if (this._frustumCull(tile, this._mode, this._projection)) {
                tile.state = TileState.READY;
                continue;
            }

            if (this._dayTileProvider.zoomMin !== 0 && tile.zoom === 0 && tile.x === 0 && tile.y === 0) {
                tile.image = this._createBaseTile();
                tile.projection = Projections.WGS84; // no need to re-project
                tile.state = TileState.IMAGE_LOADED;
            } else {
                tile.image = this._fetchImage(tile);
                if (!tile.projection) {
                    tile.projection = this._dayTileProvider.projection;
                }
            }

            ++j;
        }

        splice(this._imageQueue, 0, i);
    };

    CentralBody.prototype._createBaseTile = function() {
        // Some tile servers, like Bing, don't have a base image for the entire central body.
        // Create a 1x1 image that will never get rendered.
        var canvas = document.createElement("canvas");
        canvas.width = 1.0;
        canvas.height = 1.0;

        return canvas;
    };

    CentralBody.prototype._throttleReprojection = function() {
        var i = 0;
        var j = 0;
        for (; i < this._reprojectQueue.length && j < this._reprojectThrottleLimit; ++i) {
            var tile = this._reprojectQueue[i];

            if (this._frustumCull(tile, this._mode, this._projection)) {
                tile.image = undefined;
                tile.state = TileState.READY;
                continue;
            }

            tile.image = tile.projection.toWgs84(tile.extent, tile.image);
            tile.state = TileState.REPROJECTED;
            tile.projection = Projections.WGS84;

            ++j;
        }

        splice(this._reprojectQueue, 0, i);
    };

    CentralBody.prototype._throttleTextures = function(context) {
        var i = 0;
        var j = 0;
        for (; i < this._textureQueue.length && j < this._textureThrottleLimit; ++i) {
            var tile = this._textureQueue[i];

            if (this._frustumCull(tile, this._mode, this._projection)) {
                tile.image = undefined;
                tile.state = TileState.READY;
                continue;
            }

            tile.texture = this._textureCache.find(tile);
            tile.texture.copyFrom(tile.image);
            tile.texture.generateMipmap(MipmapHint.NICEST);
            tile.texture.setSampler({
                wrapS : TextureWrap.CLAMP,
                wrapT : TextureWrap.CLAMP,
                minificationFilter : TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
                magnificationFilter : TextureMagnificationFilter.LINEAR,
                maximumAnisotropy : context.getMaximumTextureFilterAnisotropy() || 8 // TODO: Remove Chrome work around
            });
            tile.state = TileState.TEXTURE_LOADED;
            tile.image = undefined;
            ++j;
        }

        splice(this._textureQueue, 0, i);
    };

    CentralBody.prototype._processTile = function(tile) {
        // check if tile needs to load image
        if ((!tile.state ||
             tile.state === TileState.READY ||
             tile.state === TileState.IMAGE_FAILED) &&
            this._imageQueue.indexOf(tile) === -1) {
            this._imageQueue.push(tile);
            tile.state = TileState.IMAGE_LOADING;
        }
        // or re-project the image
        else if (tile.state === TileState.IMAGE_LOADED && this._reprojectQueue.indexOf(tile) === -1) {
            this._reprojectQueue.push(tile);
            tile.state = TileState.REPROJECTING;
        }
        // or copy to a texture
        else if (tile.state === TileState.REPROJECTED && this._textureQueue.indexOf(tile) === -1) {
            this._textureQueue.push(tile);
            tile.state = TileState.TEXTURE_LOADING;
        }
        // or release invalid image if there is one
        else if (tile.state === TileState.IMAGE_INVALID && tile.image) {
            tile.image = undefined;
        }
    };

    CentralBody.prototype._enqueueTile = function(tile, context, sceneState) {
        var mode = sceneState.mode;
        var projection = sceneState.scene2D.projection;

        // tile is ready for rendering
        if (!this._dayTileProvider || (tile.state === TileState.TEXTURE_LOADED && tile.texture && !tile.texture.isDestroyed())) {
            // create vertex array the first time it is needed or when morphing
            if (!tile._extentVA ||
                tile._extentVA.isDestroyed() ||
                CentralBody._isModeTransition(this._mode, mode) ||
                tile._mode !== mode ||
                this._projection !== projection) {
                tile._extentVA = tile._extentVA && tile._extentVA.destroy();

                var ellipsoid = this._ellipsoid;
                var rtc = tile.get3DBoundingSphere().center;
                var projectedRTC = tile.get2DBoundingSphere(projection).center.clone();

                var gran = (tile.zoom > 0) ? 0.05 * (1 / tile.zoom * 2) : 0.05; // seems like a good value after testing it for what looks good

                var typedArray, buffer, stride, attributes, indexBuffer;
                var datatype = ComponentDatatype.FLOAT;
                var usage = BufferUsage.STATIC_DRAW;

                if (mode === SceneMode.SCENE3D) {
                    var buffers = ExtentTessellator.computeBuffers({
                        ellipsoid : ellipsoid,
                        extent : tile.extent,
                        granularity : gran,
                        generateTextureCoords : true,
                        interleave : true,
                        relativeToCenter : rtc
                    });

                    typedArray = datatype.toTypedArray(buffers.vertices);
                    buffer = context.createVertexBuffer(typedArray, usage);
                    stride = 5 * datatype.sizeInBytes;
                    attributes = [{
                        index : attributeIndices.position3D,
                        vertexBuffer : buffer,
                        componentDatatype : datatype,
                        componentsPerAttribute : 3,
                        normalize : false,
                        offsetInBytes : 0,
                        strideInBytes : stride
                    }, {
                        index : attributeIndices.textureCoordinates,
                        vertexBuffer : buffer,
                        componentDatatype : datatype,
                        componentsPerAttribute : 2,
                        normalize : false,
                        offsetInBytes : 3 * datatype.sizeInBytes,
                        strideInBytes : stride
                    }, {
                        index : attributeIndices.position2D,
                        value : [0.0, 0.0]
                    }];
                    indexBuffer = context.createIndexBuffer(new Uint16Array(buffers.indices), usage, IndexDatatype.UNSIGNED_SHORT);
                } else {
                    var vertices = [];
                    var width = tile.extent.east - tile.extent.west;
                    var height = tile.extent.north - tile.extent.south;
                    var lonScalar = 1.0 / width;
                    var latScalar = 1.0 / height;

                    var mesh = PlaneTessellator.compute({
                        resolution : {
                            x : Math.max(Math.ceil(width / gran), 2.0),
                            y : Math.max(Math.ceil(height / gran), 2.0)
                        },
                        onInterpolation : function(time) {
                            var lonLat = new Cartographic2(
                                    CesiumMath.lerp(tile.extent.west, tile.extent.east, time.x),
                                    CesiumMath.lerp(tile.extent.south, tile.extent.north, time.y));

                            var p = ellipsoid.toCartesian(lonLat).subtract(rtc);
                            vertices.push(p.x, p.y, p.z);

                            var u = (lonLat.longitude - tile.extent.west) * lonScalar;
                            var v = (lonLat.latitude - tile.extent.south) * latScalar;
                            vertices.push(u, v);

                            // TODO: This will not work if the projection's ellipsoid is different
                            // than the central body's ellipsoid.  Throw an exception?
                            var projectedLonLat = projection.project(lonLat).subtract(projectedRTC);
                            vertices.push(projectedLonLat.x, projectedLonLat.y);
                        }
                    });

                    typedArray = datatype.toTypedArray(vertices);
                    buffer = context.createVertexBuffer(typedArray, usage);
                    stride = 7 * datatype.sizeInBytes;
                    attributes = [{
                        index : attributeIndices.position3D,
                        vertexBuffer : buffer,
                        componentDatatype : datatype,
                        componentsPerAttribute : 3,
                        normalize : false,
                        offsetInBytes : 0,
                        strideInBytes : stride
                    }, {
                        index : attributeIndices.textureCoordinates,
                        vertexBuffer : buffer,
                        componentDatatype : datatype,
                        componentsPerAttribute : 2,
                        normalize : false,
                        offsetInBytes : 3 * datatype.sizeInBytes,
                        strideInBytes : stride
                    }, {
                        index : attributeIndices.position2D,
                        vertexBuffer : buffer,
                        componentDatatype : datatype,
                        componentsPerAttribute : 2,
                        normalize : false,
                        offsetInBytes : 5 * datatype.sizeInBytes,
                        strideInBytes : stride
                    }];

                    indexBuffer = context.createIndexBuffer(new Uint16Array(mesh.indexLists[0].values), usage, IndexDatatype.UNSIGNED_SHORT);
                }

                tile._extentVA = context.createVertexArray(attributes, indexBuffer);

                var intensity = (this._dayTileProvider && this._dayTileProvider.getIntensity && this._dayTileProvider.getIntensity(tile)) || 0.0;
                var drawUniforms = {
                    u_dayTexture : function() {
                        return tile.texture;
                    },
                    u_center3D : function() {
                        return rtc;
                    },
                    u_center2D : function() {
                        return (projectedRTC) ? projectedRTC.getXY() : Cartesian2.getZero();
                    },
                    u_modifiedModelView : function() {
                        return tile.modelView;
                    },
                    u_dayIntensity : function() {
                        return intensity;
                    }
                };
                tile._drawUniforms = combine(drawUniforms, this._drawUniforms);

                tile._mode = mode;
            }
            this._renderQueue.push(tile);

            if (mode === SceneMode.SCENE2D) {
                if (tile.zoom + 1 <= this._dayTileProvider.zoomMax) {
                    var children = tile.getChildren();
                    for ( var i = 0; i < children.length; ++i) {
                        this._processTile(children[i]);
                    }
                }
            }
        }
        // tile isn't ready, find a parent to render and start processing the tile.
        else {
            var parent = tile.parent;
            if (parent && this._renderQueue.indexOf(parent) === -1) {
                this._enqueueTile(parent, context, sceneState);
            }

            this._processTile(tile);
        }
    };

    CentralBody.prototype._refine3D = function(tile, viewportWidth, viewportHeight, mode, projection) {
        var width = viewportWidth;
        var height = viewportHeight;

        var pixelError = this.pixelError3D;
        var camera = this._camera;
        var frustum = camera.frustum;
        var provider = this._dayTileProvider;
        var extent = tile.extent;

        if (tile.zoom < provider.zoomMin) {
            return true;
        }

        var texturePixelError = (pixelError > 0.0) ? pixelError : 1.0;
        var pixelSizePerDistance = 2.0 * Math.tan(frustum.fovy * 0.5);

        if (height > width * frustum.aspectRatio) {
            pixelSizePerDistance /= height;
        } else {
            pixelSizePerDistance /= width;
        }

        var invPixelSizePerDistance = 1.0 / (texturePixelError * pixelSizePerDistance);

        var texelHeight = (extent.north - extent.south) / provider.tileHeight;
        var texelWidth = (extent.east - extent.west) / provider.tileWidth;
        var texelSize = (texelWidth > texelHeight) ? texelWidth : texelHeight;
        var dmin = texelSize * invPixelSizePerDistance;
        dmin *= this._ellipsoid.getMaximumRadius();

        var boundingVolume = this._getTileBoundingSphere(tile, mode, projection);

        var cameraPosition = camera.transform.multiplyWithVector(new Cartesian4(camera.position.x, camera.position.y, camera.position.z, 1.0)).getXYZ();
        var direction = camera.transform.multiplyWithVector(new Cartesian4(camera.direction.x, camera.direction.y, camera.direction.z, 0.0)).getXYZ();

        var toCenter = boundingVolume.center.subtract(cameraPosition);
        var toSphere = toCenter.normalize().multiplyWithScalar(toCenter.magnitude() - boundingVolume.radius);
        var distance = direction.multiplyWithScalar(direction.dot(toSphere)).magnitude();

        if (distance < dmin) {
            return true;
        }

        return false;
    };

    CentralBody.prototype._refine2D = function(tile, viewportWidth, viewportHeight, projection) {
        var camera = this._camera;
        var frustum = camera.frustum;
        var pixelError = this.pixelError2D;
        var provider = this._dayTileProvider;

        if (tile.zoom < provider.zoomMin) {
            return true;
        }

        var texturePixelError = (pixelError > 0.0) ? pixelError : 1.0;

        var tileWidth, tileHeight;
        if (tile.texture && !tile.texture.isDestroyed()) {
            tileWidth = tile.texture.getWidth();
            tileHeight = tile.texture.getHeight();
        } else if (tile.image && typeof tile.image.width !== "undefined") {
            tileWidth = tile.image.width;
            tileHeight = tile.image.height;
        } else {
            tileWidth = provider.tileWidth;
            tileHeight = provider.tileHeight;
        }

        var a = projection.project(new Cartographic2(tile.extent.west, tile.extent.north)).getXY();
        var b = projection.project(new Cartographic2(tile.extent.east, tile.extent.south)).getXY();
        var diagonal = a.subtract(b);
        var texelSize = Math.max(diagonal.x, diagonal.y) / Math.max(tileWidth, tileHeight);
        var pixelSize = Math.max(frustum.top - frustum.bottom, frustum.right - frustum.left) / Math.max(viewportWidth, viewportHeight);

        if (texelSize > pixelSize * texturePixelError) {
            return true;
        }

        return false;
    };

    /**
     * Determines whether a tile should be refined to a higher resolution.
     *
     * @memberof CentralBody
     *
     * @return {Boolean} <code>true</code> if a higher resolution tile should be displayed or <code>false</code> if a higher resolution tile is not needed.
     */
    CentralBody.prototype.refine = function(tile, viewportWidth, viewportHeight, mode, projection) {
        if (mode === SceneMode.SCENE2D) {
            return this._refine2D(tile, viewportWidth, viewportHeight, projection);
        }

        return this._refine3D(tile, viewportWidth, viewportHeight, mode, projection);
    };

    CentralBody.prototype._createScissorRectangle = function(description) {
        var quad = description.quad;
        var upperLeft = new Cartesian3(quad[0], quad[1], quad[2]);
        var lowerRight = new Cartesian3(quad[9], quad[10], quad[11]);
        var mvp = description.modelViewProjection;
        var clip = description.viewportTransformation;

        var center = upperLeft.add(lowerRight).multiplyWithScalar(0.5);
        var centerScreen = mvp.multiplyWithVector(new Cartesian4(center.x, center.y, center.z, 1.0));
        centerScreen = centerScreen.multiplyWithScalar(1.0 / centerScreen.w);
        var centerClip = clip.multiplyWithVector(centerScreen).getXYZ();

        var surfaceScreen = mvp.multiplyWithVector(new Cartesian4(upperLeft.x, upperLeft.y, upperLeft.z, 1.0));
        surfaceScreen = surfaceScreen.multiplyWithScalar(1.0 / surfaceScreen.w);
        var surfaceClip = clip.multiplyWithVector(surfaceScreen).getXYZ();

        var radius = Math.ceil(surfaceClip.subtract(centerClip).magnitude());
        var diameter = 2.0 * radius;

        return {
            x : Math.floor(centerClip.x) - radius,
            y : Math.floor(centerClip.y) - radius,
            width : diameter,
            height : diameter
        };
    };

    CentralBody.prototype._computeDepthQuad = function() {
        // PERFORMANCE_TODO: optimize diagonal matrix multiplies.
        var dInverse = Matrix3.createNonUniformScale(this._ellipsoid.getRadii());
        var d = Matrix3.createNonUniformScale(this._ellipsoid.getOneOverRadii());

        // TODO: Stop transforming camera position to world coordinates all the time.
        var p = this._camera.position;
        p = new Cartesian4(p.x, p.y, p.z, 1.0);
        p = this._camera.transform.multiplyWithVector(p).getXYZ();

        // Find the corresponding position in the scaled space of the ellipsoid.
        var q = d.multiplyWithVector(p);

        var qMagnitude = q.magnitude();
        var qUnit = q.normalize();

        // Determine the east and north directions at q.
        var eUnit = Cartesian3.getUnitZ().cross(q).normalize();
        var nUnit = qUnit.cross(eUnit).normalize();

        // Determine the radius of the "limb" of the ellipsoid.
        var wMagnitude = Math.sqrt(q.magnitudeSquared() - 1.0);

        // Compute the center and offsets.
        var center = qUnit.multiplyWithScalar(1.0 / qMagnitude);
        var scalar = wMagnitude / qMagnitude;
        var eastOffset = eUnit.multiplyWithScalar(scalar);
        var northOffset = nUnit.multiplyWithScalar(scalar);

        // A conservative measure for the longitudes would be to use the min/max longitudes of the bounding frustum.
        var upperLeft = dInverse.multiplyWithVector(center.add(northOffset).subtract(eastOffset));
        var upperRight = dInverse.multiplyWithVector(center.add(northOffset).add(eastOffset));
        var lowerLeft = dInverse.multiplyWithVector(center.subtract(northOffset).subtract(eastOffset));
        var lowerRight = dInverse.multiplyWithVector(center.subtract(northOffset).add(eastOffset));
        return [upperLeft.x, upperLeft.y, upperLeft.z, lowerLeft.x, lowerLeft.y, lowerLeft.z, upperRight.x, upperRight.y, upperRight.z, lowerRight.x, lowerRight.y, lowerRight.z];
    };

    /**
     * @private
     */
    CentralBody.prototype.update = function(context, sceneState) {
        var mode = sceneState.mode;
        var projection = sceneState.scene2D.projection;

        this._syncMorphTime(mode);

        var width, height;

        if (this._dayTileProvider !== this.dayTileProvider) {
            this._dayTileProvider = this.dayTileProvider;

            // destroy logo
            this._quadLogo = this._quadLogo && this._quadLogo.destroy();

            // stop loading everything
            this._imageQueue = [];
            this._textureQueue = [];
            this._reprojectQueue = [];

            // destroy tiles
            this._destroyTileTree();

            // destroy resources
            this._texturePool = this._texturePool && this._texturePool.destroy();
            this._textureCache = this._textureCache && this._textureCache.destroy();

            // create new tile tree
            this._rootTile = new Tile({
                extent : this._dayTileProvider.maxExtent || this._maxExtent,
                zoom : 0,
                ellipsoid : this._ellipsoid
            });

            this._prefetchImages();
        }

        var createLogo = (!this._textureLogo || !this._quadLogo || this._quadLogo.isDestroyed()) && this._dayTileProvider && this._dayTileProvider.getLogo && this._dayTileProvider.getLogo();
        if (createLogo) {
            this._textureLogo = context.createTexture2D({
                source : this._dayTileProvider.getLogo(),
                pixelFormat : PixelFormat.RGBA
            });
            this._quadLogo = new ViewportQuad(new Rectangle(this.logoOffsetX, this.logoOffsetY, this._textureLogo.getWidth(), this._textureLogo.getHeight()));
            this._quadLogo.setTexture(this._textureLogo);
        }

        if (!this._textureCache || this._textureCache.isDestroyed()) {
            this._createTextureCache(context);
        }

        width = context.getCanvas().clientWidth;
        height = context.getCanvas().clientHeight;

        var createFBO = !this._fb || this._fb.isDestroyed();
        var fboDimensionsChanged = this._fb && (this._fb.getColorTexture().getWidth() !== width || this._fb.getColorTexture().getHeight() !== height);

        if (createFBO || fboDimensionsChanged ||
            (!this._quadV || this._quadV.isDestroyed()) ||
            (!this._quadH || this._quadH.isDestroyed())) {

            this._fb = this._fb && this._fb.destroy();
            this._quadV = this._quadV && this._quadV.destroy();
            this._quadH = this._quadH && this._quadH.destroy();

            // create FBO and texture render targets
            this._fb = context.createFramebuffer({
                colorTexture : context.createTexture2D({
                    width : width,
                    height : height,
                    pixelFormat : PixelFormat.RGBA
                })
            });

            // create viewport quad for vertical gaussian blur pass
            this._quadV = new ViewportQuad(new Rectangle(0.0, 0.0, width, height));
            this._quadV.vertexShader = "#define VERTICAL 1\n" + CentralBodyVSFilter;
            this._quadV.fragmentShader = CentralBodyFSFilter;
            this._quadV.uniforms.u_height = function() {
                return height;
            };
            this._quadV.setTexture(this._fb.getColorTexture());
            this._quadV.setDestroyTexture(false);
            this._quadV.setFramebuffer(context.createFramebuffer({
                colorTexture : context.createTexture2D({
                    width : width,
                    height : height,
                    pixelFormat : PixelFormat.RGBA
                })
            }));
            this._quadV.setDestroyFramebuffer(true);

            // create viewport quad for horizontal gaussian blur pass
            this._quadH = new ViewportQuad(new Rectangle(0.0, 0.0, width, height));
            this._quadH.vertexShader = CentralBodyVSFilter;
            this._quadH.fragmentShader = CentralBodyFSFilter;
            this._quadH.uniforms.u_width = function() {
                return width;
            };
            this._quadH.setTexture(this._quadV.getFramebuffer().getColorTexture());
            this._quadH.setDestroyTexture(false);
        }

        this._quadV.update(context, sceneState);
        this._quadH.update(context, sceneState);

        if (this._quadLogo && !this._quadLogo.isDestroyed()) {
            this._quadLogo.update(context, sceneState);
        }

        var vs, fs;

        if (this.showSkyAtmosphere && !this._vaSky) {
            // PERFORMANCE_IDEA:  Is 60 the right amount to tessellate?  I think scaling the original
            // geometry in a vertex is a bad idea; at least, because it introduces a draw call per tile.
            var skyMesh = CubeMapEllipsoidTessellator.compute(new Ellipsoid(this._ellipsoid.getRadii().multiplyWithScalar(1.025)), 60);
            this._vaSky = context.createVertexArrayFromMesh({
                mesh : skyMesh,
                attributeIndices : MeshFilters.createAttributeIndices(skyMesh),
                bufferUsage : BufferUsage.STATIC_DRAW
            });

            vs = "#define SKY_FROM_SPACE \n" +
                 "#line 0 \n" +
                 SkyAtmosphereVS;

            fs = "#line 0\n" +
                 ShadersRay +
                 "#line 0\n" +
                 ShadersConstructiveSolidGeometry +
                 "#line 0\n" +
                 SkyAtmosphereFS;

            this._spSkyFromSpace = context.getShaderCache().getShaderProgram(vs, fs);

            vs = "#define SKY_FROM_ATMOSPHERE" +
                 "#line 0 \n" +
                 SkyAtmosphereVS;

            this._spSkyFromAtmosphere = context.getShaderCache().getShaderProgram(vs, fs);
            this._rsSky = context.createRenderState({
                cull : {
                    enabled : true,
                    face : CullFace.FRONT
                }
            // TODO: revisit when multi-frustum/depth test is ready
            /*depthTest : {
                enabled : true
            },
            depthMask : false*/
            });
        }

        if (CentralBody._isModeTransition(this._mode, mode) || this._projection !== projection) {
            if (mode === SceneMode.SCENE3D) {
                this._rsColor = context.createRenderState({ // Write color, not depth
                    cull : {
                        enabled : true
                    }
                });
                this._rsDepth = context.createRenderState({ // Write depth, not color
                    cull : {
                        enabled : true
                    },
                    depthTest : {
                        enabled : true,
                        func : DepthFunction.ALWAYS
                    },
                    colorMask : {
                        red : false,
                        green : false,
                        blue : false,
                        alpha : false
                    }
                });
            } else {
                this._rsColor = context.createRenderState();
                this._rsDepth = context.createRenderState();
            }
        }

        // TODO: Wait until multi-frustum
        //this._rsColor.depthTest.enabled = (mode === SceneMode.MORPHING);  // Depth test during morph
        var cull = (mode === SceneMode.SCENE3D) || (mode === SceneMode.MORPHING);
        this._rsColor.cull.enabled = cull;
        this._rsDepth.cull.enabled = cull;

        // update scisor/depth plane
        var depthQuad = this._computeDepthQuad();

        // TODO: re-enable scissorTest
        /*if (mode === SceneMode.SCENE3D) {
            var uniformState = context.getUniformState();
            var mvp = uniformState.getModelViewProjection();
            var scissorTest = {
                enabled : true,
                rectangle : this._createScissorRectangle({
                    quad : depthQuad,
                    modelViewProjection : mvp,
                    viewportTransformation : uniformState.getViewportTransformation()
                })
            };

            this._rsColor.scissorTest = scissorTest;
            this._rsDepth.scissorTest = scissorTest;
            this._quadV.renderState.scissorTest = scissorTest;
            this._quadH.renderState.scissorTest = scissorTest;
        }*/

        // depth plane
        if (!this._vaDepth) {
            var mesh = {
                attributes : {
                    position : {
                        componentDatatype : ComponentDatatype.FLOAT,
                        componentsPerAttribute : 3,
                        values : depthQuad
                    }
                },
                indexLists : [{
                    primitiveType : PrimitiveType.TRIANGLES,
                    values : [0, 1, 2, 2, 1, 3]
                }]
            };
            this._vaDepth = context.createVertexArrayFromMesh({
                mesh : mesh,
                attributeIndices : {
                    position : 0
                },
                bufferUsage : BufferUsage.DYNAMIC_DRAW
            });
        } else {
            var datatype = ComponentDatatype.FLOAT;
            this._vaDepth.getAttribute(0).vertexBuffer.copyFromArrayView(datatype.toTypedArray(depthQuad));
        }

        if (!this._spDepth) {
            this._spDepth = context.getShaderCache().getShaderProgram(
                    CentralBodyVSDepth,
                    "#line 0\n" +
                    ShadersRay +
                    "#line 0\n" +
                    ShadersConstructiveSolidGeometry +
                    "#line 0\n" +
                    CentralBodyFSDepth, {
                        position : 0
                    });
        }

        var that = this;

        // Throw exception if there was a problem asynchronously loading an image.
        if (this._exception) {
            var message = this._exception;
            this._exception = undefined;
            throw new RuntimeError(message);
        }

        // PERFORMANCE_IDEA:  Once a texture is created, it is not destroyed if
        // the corresponding show flag is turned off.  This will waste memory
        // if a user loads every texture, then sets all the flags to false.

        if (this._nightImageSource !== this.nightImageSource) {
            this._nightImageSource = this.nightImageSource;

            var nightImage = new Image();
            nightImage.onload = function() {
                that._nightTexture = that._nightTexture && that._nightTexture.destroy();
                that._nightTexture = context.createTexture2D({
                    source : nightImage,
                    pixelFormat : PixelFormat.RGB
                });
            };
            nightImage.onerror = function() {
                that._exception = "Could not load image: " + this.src + ".";
            };
            nightImage.src = this.nightImageSource;
        }

        if (this._specularMapSource !== this.specularMapSource) {
            this._specularMapSource = this.specularMapSource;

            var specularImage = new Image();
            specularImage.onload = function() {
                that._specularTexture = that._specularTexture && that._specularTexture.destroy();
                that._specularTexture = context.createTexture2D({
                    source : specularImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            specularImage.onerror = function() {
                that._exception = "Could not load image: " + this.src + ".";
            };
            specularImage.src = this.specularMapSource;
        }

        if (this._cloudsMapSource !== this.cloudsMapSource) {
            this._cloudsMapSource = this.cloudsMapSource;

            var cloudsImage = new Image();
            cloudsImage.onload = function() {
                that._cloudsTexture = that._cloudsTexture && that._cloudsTexture.destroy();
                that._cloudsTexture = context.createTexture2D({
                    source : cloudsImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            cloudsImage.onerror = function() {
                that._exception = "Could not load image: " + this.src + ".";
            };
            cloudsImage.src = this.cloudsMapSource;
        }

        if (this._bumpMapSource !== this.bumpMapSource) {
            this._bumpMapSource = this.bumpMapSource;

            var bumpImage = new Image();
            bumpImage.onload = function() {
                that._bumpTexture = that._bumpTexture && that._bumpTexture.destroy();
                that._bumpTexture = context.createTexture2D({
                    source : bumpImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            bumpImage.onerror = function() {
                that._exception = "Could not load image: " + this.src + ".";
            };
            bumpImage.src = this.bumpMapSource;
        }

        // Initial compile or re-compile if uber-shader parameters changed
        var dayChanged = ((this._showDay !== this.showDay) && (!this.showDay || this._dayTileProvider));
        var nightChanged = ((this._showNight !== this.showNight) && (!this.showNight || this._nightTexture));
        var cloudsChanged = ((this._showClouds !== this.showClouds) && (!this.showClouds || this._cloudsTexture));
        var cloudShadowsChanged = ((this._showCloudShadows !== this.showCloudShadows) && (!this.showCloudShadows || this._cloudsTexture));
        var specularChanged = ((this._showSpecular !== this.showSpecular) && (!this.showSpecular || this._specularTexture));
        var bumpsChanged = ((this._showBumps !== this.showBumps) && (!this.showBumps || this._bumpTexture));

        if (!this._sp ||
            (dayChanged || nightChanged || cloudsChanged || cloudShadowsChanged || specularChanged || bumpsChanged) ||
            (this._showTerminator !== this.showTerminator)) {

            vs = "#line 0\n" +
                 CentralBodyVS;

            fs = ((this.showDay && this._dayTileProvider) ? "#define SHOW_DAY 1\n" : "") +
                 ((this.showNight && this._nightTexture) ? "#define SHOW_NIGHT 1\n" : "") +
                 ((this.showClouds && this._cloudsTexture) ? "#define SHOW_CLOUDS 1\n" : "") +
                 ((this.showCloudShadows && this._cloudsTexture) ? "#define SHOW_CLOUD_SHADOWS 1\n" : "") +
                 ((this.showSpecular && this._specularTexture) ? "#define SHOW_SPECULAR 1\n" : "") +
                 ((this.showBumps && this._bumpTexture) ? "#define SHOW_BUMPS 1\n" : "") +
                 (this.showTerminator ? "#define SHOW_TERMINATOR 1\n" : "") +
                 "#line 0\n" +
                 CentralBodyFS;

            this._spWithoutAtmosphere = this._spWithoutAtmosphere && this._spWithoutAtmosphere.release();
            this._spGroundFromSpace = this._spGroundFromSpace && this._spGroundFromSpace.release();
            this._spGroundFromAtmosphere = this._spGroundFromAtmosphere && this._spGroundFromAtmosphere.release();

            this._spWithoutAtmosphere = context.getShaderCache().getShaderProgram(vs, fs, attributeIndices);
            this._spGroundFromSpace = context.getShaderCache().getShaderProgram(
                    "#define SHOW_GROUND_ATMOSPHERE 1\n" +
                    "#define SHOW_GROUND_ATMOSPHERE_FROM_SPACE 1\n" +
                    vs,
                    "#define SHOW_GROUND_ATMOSPHERE 1\n" +
                    "#define SHOW_GROUND_ATMOSPHERE_FROM_SPACE 1\n" +
                    fs, attributeIndices);
            this._spGroundFromAtmosphere = context.getShaderCache().getShaderProgram(
                    "#define SHOW_GROUND_ATMOSPHERE 1\n" +
                    "#define SHOW_GROUND_ATMOSPHERE_FROM_ATMOSPHERE 1\n" +
                    vs,
                    "#define SHOW_GROUND_ATMOSPHERE 1\n" +
                    "#define SHOW_GROUND_ATMOSPHERE_FROM_ATMOSPHERE 1\n" +
                    fs, attributeIndices);

            // Sync to public state
            this._showDay = dayChanged ? this.showDay : this._showDay;
            this._showNight = nightChanged ? this.showNight : this._showNight;
            this._showClouds = cloudsChanged ? this.showClouds : this._showClouds;
            this._showCloudShadows = cloudShadowsChanged ? this.showCloudShadows : this._showCloudShadows;
            this._showSpecular = specularChanged ? this.showSpecular : this._showSpecular;
            this._showBumps = bumpsChanged ? this.showBumps : this._showBumps;
            this._showTerminator = this.showTerminator;
        }

        var camera = this._camera;
        var cameraPosition = new Cartesian4(camera.position.x, camera.position.y, camera.position.z, 1.0);
        cameraPosition = camera.transform.multiplyWithVector(cameraPosition).getXYZ();
        this._fCameraHeight2 = cameraPosition.magnitudeSquared();
        this._fCameraHeight = Math.sqrt(this._fCameraHeight2);

        if (this._fCameraHeight > this._outerRadius) {
            // Viewer in space
            this._spSky = this._spSkyFromSpace;
            this._sp = this.showGroundAtmosphere ? this._spGroundFromSpace : this._spWithoutAtmosphere;
        } else {
            // after the camera passes the minimum height, there is no ground atmosphere effect
            var showAtmosphere = this._ellipsoid.toCartographic3(cameraPosition).height >= this._minGroundFromAtmosphereHeight;
            if (this.showGroundAtmosphere && showAtmosphere) {
                this._sp = this._spGroundFromAtmosphere;
            } else {
                this._sp = this._spWithoutAtmosphere;
            }
            this._spSky = this._spSkyFromAtmosphere;
        }

        this._throttleImages();
        this._throttleReprojection();
        this._throttleTextures(context);

        var viewport = context.getViewport();
        width = viewport.width;
        height = viewport.height;

        var occluder = new Occluder(new BoundingSphere(Cartesian3.getZero(), this._ellipsoid.getMinimumRadius()), cameraPosition);

        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            if (this._frustumCull(tile, mode, projection)) {
                continue;
            }

            var boundingVolume;
            if (mode === SceneMode.SCENE3D) {
                boundingVolume = tile.get3DBoundingSphere();
                var occludeePoint = tile.getOccludeePoint();

                // occlusion culling
                if (occludeePoint && !occluder.isVisible(new BoundingSphere(occludeePoint, 0.0))) {
                    continue;
                } else if (!occluder.isVisible(boundingVolume)) {
                    continue;
                }
            }

            if (!this._dayTileProvider || tile.zoom + 1 > this._dayTileProvider.zoomMax || !this.refineFunc(tile, width, height, mode, projection)) {
                this._enqueueTile(tile, context, sceneState);
            } else {
                var children = tile.getChildren();
                stack = stack.concat(children);
            }
        }

        this._mode = mode;
        this._projection = projection;
    };

    /**
     * DOC_TBA
     * @memberof CentralBody
     */
    CentralBody.prototype.render = function(context) {
        if (this.show) {
            // clear FBO
            context.clear(context.createClearState({
                framebuffer : this._fb,
                color : {
                    red : 0.0,
                    green : 0.0,
                    blue : 0.0,
                    alpha : 0.0
                }
            }));

            if (this.showSkyAtmosphere) {
                context.draw({
                    framebuffer : this._fb,
                    primitiveType : PrimitiveType.TRIANGLES,
                    shaderProgram : this._spSky,
                    uniformMap : this._drawUniforms,
                    vertexArray : this._vaSky,
                    renderState : this._rsSky
                });
            }

            var numberOfTiles = this._renderQueue.length;
            if (numberOfTiles === 0) {
                return;
            }
            var uniformState = context.getUniformState();
            var mv = uniformState.getModelView();

            context.beginDraw({
                framebuffer : this._fb,
                shaderProgram : this._sp,
                renderState : this._rsColor
            });

            // TODO: remove once multi-frustum/depth testing is implemented
            this._renderQueue.sort(function(a, b) {
                return a.zoom - b.zoom;
            });

            // render tiles to FBO
            for ( var i = 0; i < numberOfTiles; ++i) {
                var tile = this._renderQueue[i];

                var rtc;
                if (this.morphTime === 1.0) {
                    rtc = tile._drawUniforms.u_center3D();
                } else if (this.morphTime === 0.0) {
                    var center = tile._drawUniforms.u_center2D();
                    rtc = new Cartesian3(0.0, center.x, center.y);
                } else {
                    rtc = Cartesian3.getZero();
                }
                var centerEye = mv.multiplyWithVector(new Cartesian4(rtc.x, rtc.y, rtc.z, 1.0));
                var mvrtc = mv.clone();
                mvrtc.setColumn3(centerEye);
                tile.modelView = mvrtc;

                context.continueDraw({
                    primitiveType : PrimitiveType.TRIANGLES,
                    vertexArray : tile._extentVA,
                    uniformMap : tile._drawUniforms
                });
            }

            context.endDraw();

            // render quad with vertical gaussian blur with second-pass texture attached to FBO
            this._quadV.render(context);

            // render quad with horizontal gaussian blur
            this._quadH.render(context);

            // render depth plane
            if (this._mode === SceneMode.SCENE3D) {
                context.draw({
                    primitiveType : PrimitiveType.TRIANGLES,
                    shaderProgram : this._spDepth,
                    vertexArray : this._vaDepth,
                    renderState : this._rsDepth
                });
            }

            if (this._quadLogo && !this._quadLogo.isDestroyed()) {
                this._quadLogo.render(context);
            }

            this._renderQueue.length = 0;
        }
    };

    /**
     * DOC_TBA
     * @memberof CentralBody
     */
    CentralBody.prototype.renderForPick = function(context, framebuffer) {
        if (this.show) {
            if (this._mode === SceneMode.SCENE3D) {
                // Not actually pickable, but render depth-only so primitives on the backface
                // of the globe are not picked.
                context.draw({
                    primitiveType : PrimitiveType.TRIANGLES,
                    shaderProgram : this._spDepth,
                    vertexArray : this._vaDepth,
                    renderState : this._rsDepth,
                    framebuffer : framebuffer
                });
            }
        }
    };

    CentralBody.prototype._destroyTileTree = function() {
        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            // remove circular reference
            tile.parent = undefined;

            // destroy vertex array
            if (tile._extentVA) {
                tile._extentVA = tile._extentVA && tile._extentVA.destroy();
            }

            // destroy texture
            if (tile.texture) {
                // if the texture isn't in the texture pool, destroy it; otherwise,
                // it already has been or will be destroyed by it.
                var width = tile.texture.getWidth();
                var height = tile.texture.getHeight();
                var usePool = this._texturePool && (width === this._texturePool.getWidth() && height === this._texturePool.getHeight());
                tile.texture = (usePool) ? undefined : tile.texture && tile.texture.destroy();
            }

            // process children
            if (tile.children) {
                stack = stack.concat(tile.children);
            }
        }

        this._rootTile = undefined;
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof CentralBody
     *
     * @return {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see CentralBody#destroy
     */
    CentralBody.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>null</code>) to the object as done in the example.
     *
     * @memberof CentralBody
     *
     * @return {null}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see CentralBody#isDestroyed
     *
     * @example
     * centralBody = centralBody && centralBody.destroy();
     */
    CentralBody.prototype.destroy = function() {
        this._texturePool = this._texturePool && this._texturePool.destroy();
        this._textureCache = this._textureCache && this._textureCache.destroy();

        this._destroyTileTree();
        this._fb = this._fb && this._fb.destroy();
        this._quadV = this._quadV && this._quadV.destroy();
        this._quadH = this._quadH && this._quadH.destroy();

        this._spWithoutAtmosphere = this._spWithoutAtmosphere && this._spWithoutAtmosphere.release();
        this._spGroundFromSpace = this._spGroundFromSpace && this._spGroundFromSpace.release();
        this._spGroundFromAtmosphere = this._spGroundFromAtmosphere && this._spGroundFromAtmosphere.release();

        this._vaSky = this._vaSky && this._vaSky.destroy();
        this._spSkyFromSpace = this._spSkyFromSpace && this._spSkyFromSpace.release();
        this._spSkyFromAtmosphere = this._spSkyFromAtmosphere && this._spSkyFromAtmosphere.release();

        this._spDepth = this._spDepth && this._spDepth.release();
        this._vaDepth = this._vaDepth && this._vaDepth.destroy();

        this._nightTexture = this._nightTexture && this._nightTexture.destroy();
        this._specularTexture = this._specularTexture && this._specularTexture.destroy();
        this._cloudsTexture = this._cloudsTexture && this._cloudsTexture.destroy();
        this._bumpTexture = this._bumpTexture && this._bumpTexture.destroy();

        return destroyObject(this);
    };

    return CentralBody;
});
