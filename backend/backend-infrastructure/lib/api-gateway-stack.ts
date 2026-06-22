import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { createHash } from 'crypto';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * {prefix}-ApiGatewayStack — the REST API.
 *
 * Ported from reference-project/backend/backend-infrastructure/lib/api-gateway-stack.ts.
 * Changes vs reference:
 *   • `DeploymentPrefix` + ten `*LambdaArn` CfnParameters declared locally.
 *     The ten Lambda ARNs flow in from `cdk-outputs/tel-lambdas.json` at deploy
 *     time; the stack resolves each via `lambda.Function.fromFunctionArn`.
 *   • No more `userPool` / `CognitoUserPoolsAuthorizer` wiring (design §8 non-goal #8).
 *     Every method keeps `AuthorizationType.IAM` (which the reference already uses).
 *   • `restApiName` parameterized via `cdk.Fn.sub('${P}-Ordering-API', …)`.
 *   • Access-log group path parameterized via `cdk.Fn.sub('/aws/apigateway/${P}-api-access-logs', …)`.
 *   • CfnOutput `exportName` clauses stripped (P5).
 */
export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // ─────────────────────────────────────────────────────────────────────────
    // Tool/parameter documentation (Option B).
    //
    // The AgentCore Gateway fronts this REST API as MCP tools. The tool
    // descriptions the model sees come from each operation's description, and
    // the per-parameter guidance comes from request-body model schemas (for
    // POST/PUT bodies) and from query-parameter descriptions (for GETs). API
    // Gateway only emits operation/query-parameter descriptions into the OpenAPI
    // export when they are published as documentation parts in a documentation
    // version associated with the stage. We define every operation + query
    // parameter description here, snapshot them in a CfnDocumentationVersion
    // (id = content hash, so it re-snapshots only when text changes), and
    // associate that version with the prod stage. The gateway's handler exports
    // with `extensions=documentation`, so these merge into native OAS fields.
    //
    // ASCII-only: every string here is CFN-bound (working agreement #7).
    // ─────────────────────────────────────────────────────────────────────────

    // Shared id-format guidance reused across body models and query params so
    // the model picks opaque ids from context instead of substituting a
    // restaurant name or street address (which the backend cannot resolve).
    const LOCATION_ID_DESC =
      'Opaque restaurant location id, format `loc-<business-slug>-<suffix>` ' +
      '(example: `loc-amazing-burgers-r5KVG7N1`). Obtain it from GetNearestLocations ' +
      'results or the existing cart (GetCart). Never pass a restaurant name ' +
      '(e.g. "Amazing Burgers") or a street address (e.g. "123 Main Street").';
    const ITEM_ID_DESC =
      'Menu item id from a GetMenu result, e.g. `chicken-tenders`. Use the exact ' +
      'itemId returned by GetMenu; never guess or invent one.';
    const CUSTOMER_ID_DESC =
      'Opaque customer id, supplied automatically by the system. Do not ask the ' +
      'customer for it or set it yourself.';

    // One entry per documentation part. `type: METHOD` carries the operation
    // (tool) description; `type: QUERY_PARAMETER` carries a query-arg description.
    type DocSpec = {
      location: { type: string; method?: string; path?: string; name?: string };
      description: string;
    };
    const docSpecs: DocSpec[] = [
      // ---- Operation (tool) descriptions ----
      {
        location: { type: 'METHOD', method: 'GET', path: '/customers/profile' },
        description:
          "Look up the customer's saved profile: name, contact, saved preferences " +
          'and loyalty status. The customerId is supplied automatically by the ' +
          'system, so you never need to ask the customer for it. Use this to greet ' +
          'a returning customer or recall their usual preferences.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/customers/orders' },
        description:
          "Retrieve the customer's recent past orders (items, locations, dates). " +
          'The customerId is supplied automatically by the system. Use this to ' +
          'reorder a usual item or answer questions about order history.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/menu' },
        description:
          'Get the menu (items, prices, descriptions, availability) for ONE ' +
          'restaurant location. Required query parameter locationId is the opaque ' +
          'location id such as `loc-amazing-burgers-r5KVG7N1`; obtain it from ' +
          'GetNearestLocations or GetCart. Never pass a restaurant name or a street ' +
          'address as locationId. Call this before adding items so you use the real ' +
          'itemIds it returns (e.g. `chicken-tenders`).',
      },
      {
        location: { type: 'METHOD', method: 'POST', path: '/cart' },
        description:
          "Add one or more menu items to the customer's cart. Request body: " +
          'locationId (opaque location id e.g. `loc-amazing-burgers-r5KVG7N1` from ' +
          'GetNearestLocations or GetCart) and items, an array where each entry has ' +
          'itemId (the exact id from GetMenu, e.g. `chicken-tenders`) and quantity ' +
          '(e.g. 2). The customerId is supplied automatically by the system. Look ' +
          'up the menu first so the itemIds and locationId are correct.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/cart' },
        description:
          "Get the current cart: its items, the cart's locationId, item count and " +
          'subtotal. The customerId is supplied automatically by the system. Reuse ' +
          'the returned locationId for follow-up GetMenu, AddToCart or PlaceOrder ' +
          'calls so they all target the same restaurant.',
      },
      {
        location: { type: 'METHOD', method: 'PUT', path: '/cart' },
        description:
          'Modify the existing cart. Request body: action is one of clear (empty ' +
          'the cart), remove_item (needs itemId), update_quantity (needs itemId and ' +
          'quantity; quantity 0 removes the item), or change_location (needs ' +
          'newLocationId, an opaque location id like `loc-amazing-burgers-r5KVG7N1`). ' +
          'The customerId is supplied automatically by the system.',
      },
      {
        location: { type: 'METHOD', method: 'POST', path: '/order' },
        description:
          'Place the order for the items currently in the cart. Call this only ' +
          'after you have confirmed the items and the total with the customer. ' +
          'Request body: locationId (the opaque location id from the cart, e.g. ' +
          '`loc-amazing-burgers-r5KVG7N1`). The customerId and channel are supplied ' +
          'automatically by the system; never ask the customer for them.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/locations/nearest' },
        description:
          'Find restaurant locations nearest to a latitude/longitude. Returns each ' +
          "location's opaque locationId (e.g. `loc-amazing-burgers-r5KVG7N1`), name " +
          'and address. Use this to obtain a locationId before calling GetMenu or ' +
          'AddToCart. Query parameters: latitude and longitude in decimal degrees ' +
          '(e.g. 32.7767 and -96.7970) and optional maxResults (e.g. 5). If you ' +
          'only have an address, call GeocodeAddress first to get coordinates.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/locations/route' },
        description:
          'Find restaurant locations along a driving route, useful for pickup on ' +
          'the way somewhere. Query parameters: startLatitude, startLongitude, ' +
          'endLatitude, endLongitude in decimal degrees (e.g. 32.7767 / -96.7970) ' +
          'and optional maxDetourMinutes (e.g. 10). Returns locationIds you can pass ' +
          'to GetMenu or AddToCart.',
      },
      {
        location: { type: 'METHOD', method: 'GET', path: '/locations/geocode' },
        description:
          'Convert a street address or place name into latitude/longitude ' +
          'coordinates so you can then call GetNearestLocations or ' +
          'FindLocationAlongRoute. Query parameter address is free text, e.g. ' +
          '"123 Main Street, Dallas TX".',
      },
      // ---- Query-parameter descriptions ----
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/customers/profile', name: 'customerId' }, description: CUSTOMER_ID_DESC },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/customers/orders', name: 'customerId' }, description: CUSTOMER_ID_DESC },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/cart', name: 'customerId' }, description: CUSTOMER_ID_DESC },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/menu', name: 'locationId' }, description: LOCATION_ID_DESC },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/nearest', name: 'latitude' }, description: 'Latitude in decimal degrees, e.g. 32.7767.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/nearest', name: 'longitude' }, description: 'Longitude in decimal degrees, e.g. -96.7970.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/nearest', name: 'maxResults' }, description: 'Optional. Maximum number of locations to return, e.g. 5.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/route', name: 'startLatitude' }, description: 'Route start latitude in decimal degrees, e.g. 32.7767.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/route', name: 'startLongitude' }, description: 'Route start longitude in decimal degrees, e.g. -96.7970.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/route', name: 'endLatitude' }, description: 'Route end latitude in decimal degrees, e.g. 32.7820.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/route', name: 'endLongitude' }, description: 'Route end longitude in decimal degrees, e.g. -96.7700.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/route', name: 'maxDetourMinutes' }, description: 'Optional. Maximum acceptable detour from the route in minutes, e.g. 10.' },
      { location: { type: 'QUERY_PARAMETER', method: 'GET', path: '/locations/geocode', name: 'address' }, description: 'Street address or place to geocode, free text, e.g. "123 Main Street, Dallas TX".' },
    ];

    // Content hash -> documentation version id. Changes only when the text above
    // changes, so no-op deploys do not churn the version (and the version
    // resource's logical id folds in the hash for clean create-before-delete).
    const docVersionId =
      'docs-' +
      createHash('sha256').update(JSON.stringify(docSpecs)).digest('hex').slice(0, 12);

    // Ten CfnParameters - one per ordering Lambda ARN.
    const mkArnParam = (name: string, desc: string) =>
      new cdk.CfnParameter(this, name, {
        type: 'String',
        minLength: 1,
        description: desc,
      });

    const getCustomerProfileArn = mkArnParam(
      'GetCustomerProfileLambdaArn',
      'ARN of GetCustomerProfile Lambda (from cdk-outputs/tel-lambdas.json)',
    );
    const getPreviousOrdersArn = mkArnParam(
      'GetPreviousOrdersLambdaArn',
      'ARN of GetPreviousOrders Lambda',
    );
    const getMenuArn = mkArnParam('GetMenuLambdaArn', 'ARN of GetMenu Lambda');
    const addToCartArn = mkArnParam(
      'AddToCartLambdaArn',
      'ARN of AddToCart Lambda',
    );
    const getCartArn = mkArnParam('GetCartLambdaArn', 'ARN of GetCart Lambda');
    const updateCartArn = mkArnParam(
      'UpdateCartLambdaArn',
      'ARN of UpdateCart Lambda',
    );
    const placeOrderArn = mkArnParam(
      'PlaceOrderLambdaArn',
      'ARN of PlaceOrder Lambda',
    );
    const getNearestLocationsArn = mkArnParam(
      'GetNearestLocationsLambdaArn',
      'ARN of GetNearestLocations Lambda',
    );
    const findLocationAlongRouteArn = mkArnParam(
      'FindLocationAlongRouteLambdaArn',
      'ARN of FindLocationAlongRoute Lambda',
    );
    const geocodeAddressArn = mkArnParam(
      'GeocodeAddressLambdaArn',
      'ARN of GeocodeAddress Lambda',
    );

    // Resolve each ARN back to an IFunction. `fromFunctionArn` produces a
    // handle suitable for `LambdaIntegration` — but because the Lambda was
    // created in a different stack, CDK cannot automatically add the
    // resource-based `AWS::Lambda::Permission` that lets API Gateway invoke
    // it. We add those permissions explicitly below (see `addInvokePermission`)
    // after the RestApi is constructed so we know `this.api.restApiId` is
    // available.
    const fn = (id: string, arnParam: cdk.CfnParameter) =>
      lambda.Function.fromFunctionArn(this, id, arnParam.valueAsString);

    const getCustomerProfile = fn(
      'GetCustomerProfileRef',
      getCustomerProfileArn,
    );
    const getPreviousOrders = fn(
      'GetPreviousOrdersRef',
      getPreviousOrdersArn,
    );
    const getMenu = fn('GetMenuRef', getMenuArn);
    const addToCart = fn('AddToCartRef', addToCartArn);
    const getCart = fn('GetCartRef', getCartArn);
    const updateCart = fn('UpdateCartRef', updateCartArn);
    const placeOrder = fn('PlaceOrderRef', placeOrderArn);
    const getNearestLocations = fn(
      'GetNearestLocationsRef',
      getNearestLocationsArn,
    );
    const findLocationAlongRoute = fn(
      'FindLocationAlongRouteRef',
      findLocationAlongRouteArn,
    );
    const geocodeAddress = fn('GeocodeAddressRef', geocodeAddressArn);

    // CloudWatch access-log group.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: cdk.Fn.sub('/aws/apigateway/${P}-api-access-logs', {
        P: prefix,
      }),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // REST API.
    this.api = new apigateway.RestApi(this, 'QSRApi', {
      restApiName: cdk.Fn.sub('${P}-Ordering-API', { P: prefix }),
      description:
        'REST API for QSR ordering system (AgentCore Gateway + telephony agent are the only callers; AWS_IAM authz)',
      deployOptions: {
        stageName: 'prod',
        documentationVersion: docVersionId,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // ───── Lambda invoke permissions (one AWS::Lambda::Permission per fn) ─────
    //
    // Every Lambda integrated via `LambdaIntegration` needs a resource-based
    // policy allowing `apigateway.amazonaws.com` to `lambda:InvokeFunction` on
    // it, scoped to this REST API's source ARN. CDK auto-generates these
    // statements when the Function construct is in the same synth tree — but
    // here we split the stacks and the Lambdas arrive via `fromFunctionArn`,
    // so we must emit the permission ourselves or API Gateway returns
    // `"Execution failed due to configuration error: Invalid permissions on
    // Lambda function"` and every method returns 500.
    //
    // Source ARN pattern `${apiArn}/*/*/*` covers stage/method/resource —
    // the three-wildcard form API Gateway recommends for integrations that
    // don't need tight method-level scoping.
    const lambdaPermissionTargets: { id: string; arnParam: cdk.CfnParameter }[] = [
      { id: 'GetCustomerProfilePermission', arnParam: getCustomerProfileArn },
      { id: 'GetPreviousOrdersPermission', arnParam: getPreviousOrdersArn },
      { id: 'GetMenuPermission', arnParam: getMenuArn },
      { id: 'AddToCartPermission', arnParam: addToCartArn },
      { id: 'GetCartPermission', arnParam: getCartArn },
      { id: 'UpdateCartPermission', arnParam: updateCartArn },
      { id: 'PlaceOrderPermission', arnParam: placeOrderArn },
      { id: 'GetNearestLocationsPermission', arnParam: getNearestLocationsArn },
      { id: 'FindLocationAlongRoutePermission', arnParam: findLocationAlongRouteArn },
      { id: 'GeocodeAddressPermission', arnParam: geocodeAddressArn },
    ];
    const apiSourceArn = cdk.Fn.sub(
      'arn:aws:execute-api:${R}:${A}:${Id}/*/*/*',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        Id: this.api.restApiId,
      },
    );
    for (const t of lambdaPermissionTargets) {
      new lambda.CfnPermission(this, t.id, {
        action: 'lambda:InvokeFunction',
        functionName: t.arnParam.valueAsString,
        principal: 'apigateway.amazonaws.com',
        sourceArn: apiSourceArn,
      });
    }

    // Response models
    const successResponseModel = this.api.addModel('SuccessResponse', {
      contentType: 'application/json',
      modelName: 'SuccessResponse',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Success Response',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          statusCode: { type: apigateway.JsonSchemaType.INTEGER },
          body: { type: apigateway.JsonSchemaType.STRING },
        },
      },
    });

    const errorResponseModel = this.api.addModel('ErrorResponse', {
      contentType: 'application/json',
      modelName: 'ErrorResponse',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Error Response',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          statusCode: { type: apigateway.JsonSchemaType.INTEGER },
          message: { type: apigateway.JsonSchemaType.STRING },
        },
      },
    });

    // Request body models. (LOCATION_ID_DESC / ITEM_ID_DESC are defined near the
    // top of the constructor and reused here so body-model property descriptions
    // match the query-parameter documentation parts.)

    const addToCartRequestModel = this.api.addModel('AddToCartRequest', {
      contentType: 'application/json',
      modelName: 'AddToCartRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Add To Cart Request',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          customerId: { type: apigateway.JsonSchemaType.STRING, description: CUSTOMER_ID_DESC },
          locationId: { type: apigateway.JsonSchemaType.STRING, description: LOCATION_ID_DESC },
          items: {
            type: apigateway.JsonSchemaType.ARRAY,
            items: {
              type: apigateway.JsonSchemaType.OBJECT,
              properties: {
                itemId: { type: apigateway.JsonSchemaType.STRING, description: ITEM_ID_DESC },
                quantity: {
                  type: apigateway.JsonSchemaType.INTEGER,
                  description: 'Number of this item to add, e.g. 2.',
                },
              },
              required: ['itemId', 'quantity'],
            },
          },
        },
        required: ['customerId', 'locationId', 'items'],
      },
    });

    const placeOrderRequestModel = this.api.addModel('PlaceOrderRequest', {
      contentType: 'application/json',
      modelName: 'PlaceOrderRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Place Order Request',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          customerId: { type: apigateway.JsonSchemaType.STRING, description: CUSTOMER_ID_DESC },
          locationId: { type: apigateway.JsonSchemaType.STRING, description: LOCATION_ID_DESC },
          channel: {
            type: apigateway.JsonSchemaType.STRING,
            description:
              'Order channel, supplied automatically by the system (e.g. whatsapp). Do not set this yourself.',
          },
          anonymousCaller: {
            type: apigateway.JsonSchemaType.BOOLEAN,
            description: 'Internal flag, supplied automatically by the system.',
          },
          fromPhoneNumber: {
            type: apigateway.JsonSchemaType.STRING,
            description: 'Internal field, supplied automatically by the system when applicable.',
          },
        },
        required: ['customerId', 'locationId'],
      },
    });

    const updateCartRequestModel = this.api.addModel('UpdateCartRequest', {
      contentType: 'application/json',
      modelName: 'UpdateCartRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Update Cart Request',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          customerId: { type: apigateway.JsonSchemaType.STRING, description: CUSTOMER_ID_DESC },
          action: {
            type: apigateway.JsonSchemaType.STRING,
            enum: ['clear', 'remove_item', 'update_quantity', 'change_location'],
            description:
              'The cart operation. "clear" empties the cart. "remove_item" removes one item (requires itemId). "update_quantity" sets an item quantity (requires itemId and quantity; a quantity of 0 removes the item). "change_location" switches the pickup location (requires newLocationId).',
          },
          itemId: {
            type: apigateway.JsonSchemaType.STRING,
            description:
              'Item id to remove or update (for remove_item and update_quantity). ' +
              ITEM_ID_DESC,
          },
          quantity: {
            type: apigateway.JsonSchemaType.INTEGER,
            description: 'New quantity for update_quantity (0 removes the item).',
          },
          newLocationId: {
            type: apigateway.JsonSchemaType.STRING,
            description: 'New pickup location id (for change_location). ' + LOCATION_ID_DESC,
          },
        },
        required: ['customerId', 'action'],
      },
    });

    const requestValidator = new apigateway.RequestValidator(
      this,
      'RequestValidator',
      {
        restApi: this.api,
        requestValidatorName: 'request-body-validator',
        validateRequestBody: true,
        validateRequestParameters: true,
      },
    );

    // Lambda integrations (proxy).
    const integ = (f: lambda.IFunction) =>
      new apigateway.LambdaIntegration(f, {
        proxy: true,
        allowTestInvoke: true,
      });

    // Customer ops
    const customers = this.api.root.addResource('customers', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
      },
    });

    const customerProfile = customers.addResource('profile');
    customerProfile.addMethod('GET', integ(getCustomerProfile), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetCustomerProfile',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
    });

    const orders = customers.addResource('orders');
    orders.addMethod('GET', integ(getPreviousOrders), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetPreviousOrders',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
    });

    // Menu
    const menu = this.api.root.addResource('menu');
    menu.addMethod('GET', integ(getMenu), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetMenu',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.locationId': true,
      },
    });

    // Cart
    const cart = this.api.root.addResource('cart');
    cart.addMethod('POST', integ(addToCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'AddToCart',
      requestValidator,
      requestModels: { 'application/json': addToCartRequestModel },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });
    cart.addMethod('GET', integ(getCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetCart',
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });
    cart.addMethod('PUT', integ(updateCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'UpdateCart',
      requestValidator,
      requestModels: { 'application/json': updateCartRequestModel },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });

    // Order
    const order = this.api.root.addResource('order');
    order.addMethod('POST', integ(placeOrder), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'PlaceOrder',
      requestValidator,
      requestModels: { 'application/json': placeOrderRequestModel },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });

    // Locations
    const locations = this.api.root.addResource('locations');
    const nearest = locations.addResource('nearest');
    nearest.addMethod('GET', integ(getNearestLocations), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetNearestLocations',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.latitude': true,
        'method.request.querystring.longitude': true,
        'method.request.querystring.maxResults': false,
      },
    });

    const route = locations.addResource('route');
    route.addMethod('GET', integ(findLocationAlongRoute), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'FindLocationAlongRoute',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.startLatitude': true,
        'method.request.querystring.startLongitude': true,
        'method.request.querystring.endLatitude': true,
        'method.request.querystring.endLongitude': true,
        'method.request.querystring.maxDetourMinutes': false,
      },
    });

    const geocode = locations.addResource('geocode');
    geocode.addMethod('GET', integ(geocodeAddress), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GeocodeAddress',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.address': true,
      },
    });

    // ───────────── API documentation parts + version (Option B) ─────────────
    //
    // Materialize every entry in `docSpecs` as a CfnDocumentationPart, then
    // snapshot them all into one CfnDocumentationVersion that the prod stage
    // references (via deployOptions.documentationVersion = docVersionId set
    // above). Dependency chain: each part -> version -> deployment stage, so
    // CloudFormation creates the parts first, snapshots a complete set, then
    // points the stage at it. The version's logical id folds in the content
    // hash so a text change creates a NEW version (create-before-delete) and
    // the stage is repointed before the old version is removed.
    const docParts = docSpecs.map((spec, i) => {
      const loc = spec.location;
      const idHint = `${loc.type}-${(loc.method ?? 'X')}-${(loc.path ?? '/').replace(/[^a-zA-Z0-9]/g, '')}-${loc.name ?? 'op'}`;
      const part = new apigateway.CfnDocumentationPart(this, `DocPart${i}-${idHint}`, {
        restApiId: this.api.restApiId,
        location: loc,
        properties: JSON.stringify({ description: spec.description }),
      });
      // The /menu locationId query-parameter doc part was first deployed under
      // the logical id `GetMenuLocationIdDocPart`. Keep that logical id so the
      // stack UPDATES it in place rather than create-new + delete-old, which
      // would 409 (a documentation part is unique per location).
      if (loc.type === 'QUERY_PARAMETER' && loc.path === '/menu' && loc.name === 'locationId') {
        part.overrideLogicalId('GetMenuLocationIdDocPart');
      }
      return part;
    });

    const docVersion = new apigateway.CfnDocumentationVersion(
      this,
      `DocVersion-${docVersionId}`,
      {
        restApiId: this.api.restApiId,
        documentationVersion: docVersionId,
        description: 'QSR ordering tool/parameter documentation snapshot',
      },
    );
    // parts -> version (complete snapshot), version -> stage (reference exists).
    for (const p of docParts) docVersion.node.addDependency(p);
    this.api.deploymentStage.node.addDependency(docVersion);

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      description: 'API Gateway endpoint URL',
    });
    new cdk.CfnOutput(this, 'ApiGatewayId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
    });
    new cdk.CfnOutput(this, 'ApiGatewayRestApiId', {
      value: this.api.restApiId,
      description:
        'API Gateway REST API ID (consumed by AgentCoreGatewayStack for its execute-api resource ARN)',
    });
    new cdk.CfnOutput(this, 'ApiGatewayArn', {
      value: cdk.Fn.sub('arn:aws:execute-api:${R}:${A}:${Id}/*', {
        R: this.region,
        A: this.account,
        Id: this.api.restApiId,
      }),
      description: 'API Gateway ARN for IAM permissions',
    });

    // ───────────── cdk-nag suppressions ─────────────
    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-COG4',
          reason:
            'REST API uses AWS_IAM authorization, not a Cognito User Pool Authorizer. Cognito is deliberately out of scope for telephony (design §8 non-goal #8); the AgentCore Gateway SigV4-invokes this API using its own IAM role.',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason:
            'WAF is out of scope for the MVP (design §8 non-goals). Revisit before production.',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'CORS preflight OPTIONS methods use `AuthorizationType.NONE` by design — authenticated OPTIONS is not a pattern supported by CloudFront/browsers. All non-OPTIONS methods use AWS_IAM.',
        },
      ],
      true,
    );
  }
}
